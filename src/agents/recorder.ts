/**
 * Recorder: an observer participant. It never acts; it writes every Inquest
 * event to the run log (SQLite) and forwards it to live listeners (the
 * dashboard's server-sent events stream).
 */
import { createHuman, type Human, type SemanticEvent } from "@mozaik-ai/core"
import { EventEmitter } from "node:events"
import { EV } from "../runtime/events.js"
import { AnyEvent, runtimeState } from "../runtime/runtime.js"

export interface LiveEvent {
  id: number
  at: number
  type: string
  producer: string
  role: string | null
  payload: unknown
}

/** In-process bus the HTTP server subscribes to. */
export const liveBus = new EventEmitter()
liveBus.setMaxListeners(100)

const CUSTOM = new Set<string>(Object.values(EV))
let seq = 0

function summarize(event: SemanticEvent): { keep: boolean; payload: unknown } {
  if (CUSTOM.has(event.type)) {
    if (event.type === EV.dossierDrafted) {
      const { caseId, version, title } = event.payload as { caseId: number; version: number; title: string }
      return { keep: true, payload: { caseId, version, title } }
    }
    return { keep: true, payload: event.payload }
  }
  // Mozaik agent-loop events of the LLM workers: keep a compact trace.
  if (event.type === "inference.started") return { keep: true, payload: {} }
  if (event.type === "inference.completed") {
    const usage = (event.payload as { tokenUsage?: { inputTokens: number; outputTokens: number } }).tokenUsage
    return { keep: true, payload: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {} }
  }
  return { keep: false, payload: null }
}

export function createRecorder(): Human {
  const state = runtimeState()
  return createHuman({
    name: "Recorder",
    capabilities: ["observer"],
    handlers: [
      {
        specification: new AnyEvent(),
        processor: {
          apply({ event }) {
            const { keep, payload } = summarize(event)
            if (!keep) return
            const participant = state.getParticipant(event.producerId)
            const role = state.roles.get(event.producerId) ?? null
            const producer = participant?.getManifest().name ?? event.producerId
            state.board?.logEvent(event.type, producer, role, payload)
            const live: LiveEvent = { id: ++seq, at: event.occurredAt.getTime(), type: event.type, producer, role, payload }
            liveBus.emit("event", live)
          },
        },
      },
    ],
  })
}
