/**
 * LLM calls through Mozaik.
 *
 * Each call spawns a short-lived Mozaik agent (an "LLM worker" of the calling
 * role), joins it to the runtime, runs one agent loop with a JSON-schema
 * structured output, waits for its own `model.answer` event, and leaves. Using
 * one worker per call keeps contexts separate, lets many calls of the same
 * agent run concurrently, and makes every inference visible as runtime events.
 *
 * When the LLM is disabled (no API key or INQUEST_LLM_MODE=offline), or the
 * per-case budget is used up, or the call fails, the caller's deterministic
 * `offline` fallback is used instead. The result says which path was taken.
 */
import { Agent, createAgent, type SituationHandler } from "@mozaik-ai/core"
import { CONFIG } from "../config.js"
import type { AgentRole } from "../domain/types.js"
import { OnEvents, join, leave, runLoop, runtimeState, sleep } from "../runtime/runtime.js"

export type JsonSchema = Record<string, unknown>

export interface ThinkOptions<T> {
  role: AgentRole
  task: string
  instruction: string
  prompt: string
  schema: JsonSchema
  model?: "fast" | "smart"
  caseId?: number
  maxOutputTokens?: number
  offline: () => T
}

export interface ThinkResult<T> {
  value: T
  via: "llm" | "offline"
  ms: number
  note?: string
}

class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
  }
  release(): void {
    this.active--
    this.queue.shift()?.()
  }
}

const semaphore = new Semaphore(CONFIG.llm.concurrency)
const callsPerCase = new Map<number, number>()

export function resetLlmBudget(): void {
  callsPerCase.clear()
}

export function llmEnabled(): boolean {
  return CONFIG.llm.enabled
}

/** Object schema helper: every property required, no extra properties (needed for strict structured output). */
export function obj(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) }
}
export const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) })
export const num = (description?: string): JsonSchema => ({ type: "number", ...(description ? { description } : {}) })
export const bool = (description?: string): JsonSchema => ({ type: "boolean", ...(description ? { description } : {}) })
export const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] })
export const arr = (items: JsonSchema, description?: string): JsonSchema => ({ type: "array", items, ...(description ? { description } : {}) })

export async function think<T>(opts: ThinkOptions<T>): Promise<ThinkResult<T>> {
  const state = runtimeState()
  const started = Date.now()
  const offline = async (note?: string): Promise<ThinkResult<T>> => {
    state.counters.llmOfflineCalls++
    if (CONFIG.llm.offlineLatencyMs > 0) await sleep(CONFIG.llm.offlineLatencyMs)
    return { value: opts.offline(), via: "offline", ms: Date.now() - started, note }
  }

  if (!CONFIG.llm.enabled) return offline()
  if (opts.caseId !== undefined) {
    const used = callsPerCase.get(opts.caseId) ?? 0
    if (used >= CONFIG.llm.budgetPerCase) return offline("LLM budget for this case used up")
    callsPerCase.set(opts.caseId, used + 1)
  }

  await semaphore.acquire()
  try {
    state.counters.llmCalls++
    const text = await runWorker(opts)
    const parsed = JSON.parse(extractJson(text)) as T & { __inquest_error?: string }
    if (parsed && typeof parsed === "object" && "__inquest_error" in parsed) throw new Error(String(parsed.__inquest_error))
    return { value: parsed, via: "llm", ms: Date.now() - started }
  } catch (error) {
    state.counters.llmFailures++
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[llm] ${opts.role}/${opts.task} failed, using offline fallback: ${message.slice(0, 200)}`)
    return offline(`LLM call failed: ${message.slice(0, 200)}`)
  } finally {
    semaphore.release()
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1]
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

/** Spawn a one-shot Mozaik agent, run its loop, and resolve with its answer text. */
function runWorker<T>(opts: ThinkOptions<T>): Promise<string> {
  const state = runtimeState()
  return new Promise<string>((resolve, reject) => {
    let worker: Agent | null = null
    const timer = setTimeout(() => finish(new Error(`timeout after ${CONFIG.llm.timeoutMs} ms`)), CONFIG.llm.timeoutMs)
    const finish = (error: Error | null, text?: string) => {
      clearTimeout(timer)
      if (worker) {
        try {
          leave(worker)
        } catch {
          /* already left */
        }
        state.roles.delete(worker.getId())
      }
      if (error) reject(error)
      else resolve(text ?? "")
    }
    const onOwnAnswer: SituationHandler = {
      specification: new OnEvents(["model.answer"], true),
      processor: {
        apply({ event, participant }) {
          if (event.producerId !== participant.getId()) return
          const payload = event.payload as { answer?: { content?: { text?: string } } }
          finish(null, payload.answer?.content?.text ?? "")
        },
      },
    }
    worker = createAgent({
      name: `${opts.role}/${opts.task}`,
      capabilities: ["inference", "ephemeral", `role:${opts.role}`],
      instruction: opts.instruction,
      tools: [],
      handlers: [onOwnAnswer],
    })
    state.roles.set(worker.getId(), opts.role)
    join(worker)
    runLoop(worker.getId(), opts.prompt, {
      model: opts.model === "smart" ? CONFIG.llm.modelSmart : CONFIG.llm.modelFast,
      context: worker.getMemory().getContext(),
      structuredOutput: { name: opts.task.replace(/[^a-zA-Z0-9_]/g, "_"), schema: opts.schema, strict: true },
      maxOutputTokens: opts.maxOutputTokens ?? 2000,
    })
  })
}

/** Shared wording rules for every prompt that produces user-facing text. */
export const LANGUAGE_RULES = `Wording rules (mandatory):
- Describe risk signals, never guilt. Use phrases like "risk signal", "unusual", "worth checking".
- Never use the words corruption, fraud, theft, bribery, criminal (or their Serbian equivalents) about any entity.
- Only state numbers that are given to you as facts. Do not invent, round differently, or recompute numbers.`

export function reportLanguageInstruction(): string {
  return CONFIG.llm.reportLanguage === "sr"
    ? "Write all human-readable text in Serbian (Latin script)."
    : "Write all human-readable text in English."
}
