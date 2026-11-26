/**
 * The Mozaik runtime shared by every Inquest participant.
 *
 * - Agents and observers join the runtime and react to events through
 *   situation handlers; nobody polls.
 * - Shared investigation state lives in SQLite (the case board); the runtime
 *   state only keeps bookkeeping for the current run: which work is in flight,
 *   counters, and the board handle.
 */
import {
  ModelMessageItem,
  RuntimeState,
  SemanticEvent,
  SituationSpecification,
  defineRuntime,
  supportedModels,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type Participant,
  type SituationContext,
  type SituationHandler,
} from "@mozaik-ai/core"
import type { CaseBoard } from "../db/board.js"

export interface RunCounters {
  llmCalls: number
  llmOfflineCalls: number
  llmFailures: number
  inputTokens: number
  outputTokens: number
  webSearches: number
  webPages: number
  eventsPublished: number
}

export class InquestState extends RuntimeState {
  board: CaseBoard | null = null
  runId = ""
  mode: "team" | "single" = "team"
  startedAtMs = 0
  /** Work in flight, keyed by what it touches (payment:<id>, case:<id>, entity:<type>:<id>, ...). */
  inflight = new Map<string, number>()
  counters: RunCounters = emptyCounters()
  /** Called whenever in-flight work finishes; used to detect that a run has settled. */
  idleListeners = new Set<() => void>()
  /** Role of every participant, by participant id (ephemeral LLM workers included). */
  roles = new Map<string, string>()

  beginRun(runId: string, mode: "team" | "single", board: CaseBoard): void {
    if (this.board && this.board !== board) {
      try {
        this.board.close()
      } catch {
        /* already closed */
      }
    }
    this.runId = runId
    this.mode = mode
    this.board = board
    this.startedAtMs = Date.now()
    this.inflight.clear()
    this.counters = emptyCounters()
  }

  requireBoard(): CaseBoard {
    if (!this.board) throw new Error("No active run: board not set")
    return this.board
  }

  begin(keys: string[]): void {
    for (const k of keys) this.inflight.set(k, (this.inflight.get(k) ?? 0) + 1)
  }

  end(keys: string[]): void {
    for (const k of keys) {
      const n = (this.inflight.get(k) ?? 0) - 1
      if (n <= 0) this.inflight.delete(k)
      else this.inflight.set(k, n)
    }
    if (this.inflight.size === 0) for (const l of [...this.idleListeners]) l()
  }

  isBusy(keys: string[]): boolean {
    return keys.some((k) => this.inflight.has(k))
  }

  countInflight(prefix: string): number {
    let n = 0
    for (const [k, v] of this.inflight) if (k.startsWith(prefix)) n += v
    return n
  }
}

function emptyCounters(): RunCounters {
  return { llmCalls: 0, llmOfflineCalls: 0, llmFailures: 0, inputTokens: 0, outputTokens: 0, webSearches: 0, webPages: 0, eventsPublished: 0 }
}

/**
 * Wraps Mozaik's default inference runner so that a failed model call ends the
 * agent loop with an error answer instead of an unhandled rejection (runLoop is
 * fire-and-forget, so a thrown error would otherwise never reach the caller).
 * It also counts tokens for the run report.
 */
class SafeInferenceRunner implements InferenceRunner {
  private model(name: string) {
    const model = supportedModels.find((m) => m.specification.name === name)
    if (!model) throw new Error(`Model "${name}" is not supported by Mozaik (see supportedModels)`)
    return model
  }

  async run(request: InferenceInput): Promise<InferenceOutput> {
    try {
      const model = this.model(request.model)
      if (request.structuredOutput && !model.specification.supportsStructuredOutput) {
        throw new Error(`Model "${request.model}" does not support structured output`)
      }
      const out = await model.endpoint.infer(request)
      const state = runtimeState()
      if (out.tokenUsage) {
        state.counters.inputTokens += out.tokenUsage.inputTokens
        state.counters.outputTokens += out.tokenUsage.outputTokens
      }
      return out
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ __inquest_error: message.slice(0, 500) }) })],
        tokenUsage: undefined,
        rowResponse: null,
      }
    }
  }

  async *stream(request: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield* this.model(request.model).endpoint.stream(request)
  }
}

// Mozaik's cloud client prints its "no API key - telemetry disabled" notice for
// every agent loop. Show it once instead of once per LLM call.
const originalWarn = console.warn
let cloudNoticeShown = false
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("mozaik cloud: no API key")) {
    if (cloudNoticeShown) return
    cloudNoticeShown = true
  }
  originalWarn(...args)
}

// Mozaik opens one cloud session per agent loop and prints its link each time.
// Print the first link and a single pointer to the project view, not one line per LLM call.
const originalLog = console.log
let cloudLinks = 0
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("mozaik cloud") && args[0].includes("watching live")) {
    cloudLinks++
    if (cloudLinks > 1) return
    originalLog(args[0])
    originalLog("  (each LLM call is its own Mozaik loop; see all of them under Agents at https://app.jigjoy.ai)")
    return
  }
  originalLog(...args)
}

// Last-resort guard: a Mozaik loop that outlives its agent rejects with
// "Participant ... not found" in fire-and-forget code. Log it instead of crashing the process.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/^Participant .* not found$/.test(message)) {
    console.warn(`[mozaik] ignored late event from a finished agent: ${message}`)
    return
  }
  console.error("Unhandled rejection:", reason)
  process.exitCode = 1
})

const runtime = defineRuntime<InquestState>()
export const { join, leave, sendEvent, runLoop, resolveRuntime } = runtime

let initialized = false
export function ensureRuntime(): InquestState {
  if (!initialized) {
    runtime.initializeRuntime({ state: new InquestState(), inferenceRunnerConfig: { runner: new SafeInferenceRunner() } })
    initialized = true
  }
  return resolveRuntime().state
}

export function runtimeState(): InquestState {
  return resolveRuntime().state
}

/** Publish a custom Inquest event from a joined participant. */
export function emit<T>(producer: Participant, type: string, payload: T): void {
  runtimeState().counters.eventsPublished++
  sendEvent(SemanticEvent.create(type, producer.getId(), payload), producer.getId())
}

/** Matches events of the given types produced by someone else. */
export class OnEvents extends SituationSpecification {
  constructor(private readonly types: readonly string[], private readonly includeOwn = false) {
    super()
  }
  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    return this.types.includes(event.type) && (this.includeOwn || event.producerId !== participant.getId())
  }
}

/** Matches every event (used by observers such as the recorder). */
export class AnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true
  }
}

/**
 * Build a situation handler whose processor is an async function. The runtime
 * never awaits processors, so errors are caught here and reported as an
 * `agent.error` event instead of crashing the process.
 */
export function react<P = unknown>(
  types: readonly string[],
  fn: (payload: P, event: SemanticEvent, self: Participant) => void | Promise<void>,
  opts: { includeOwn?: boolean } = {},
): SituationHandler {
  return {
    specification: new OnEvents(types, opts.includeOwn),
    processor: {
      apply({ event, participant }) {
        Promise.resolve()
          .then(() => fn(event.payload as P, event, participant))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.stack ?? error.message : String(error)
            console.error(`[${runtimeState().roles.get(participant.getId()) ?? participant.getManifest().name}] ${event.type}:`, message)
            try {
              emit(participant, "agent.error", { eventType: event.type, message: message.slice(0, 1000) })
            } catch {
              /* participant may have left */
            }
          })
      },
    },
  }
}

/** Run `fn` while marking `keys` as in flight, so the run is not considered settled meanwhile. */
export async function tracked<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const state = runtimeState()
  state.begin(keys)
  try {
    return await fn()
  } finally {
    state.end(keys)
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
