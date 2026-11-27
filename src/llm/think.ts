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
  /** When false, skip the LLM and use the offline result (the answer could not change the outcome). */
  useLlm?: boolean
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

export function isGemini(model: string): boolean {
  return model.startsWith("gemini")
}

/**
 * Gemini's responseSchema is an OpenAPI subset: it rejects `additionalProperties`
 * and `{ type: "null" }`, and marks optional values with `nullable: true` instead.
 */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const anyOf = schema.anyOf as JsonSchema[] | undefined
  if (anyOf) {
    const rest = anyOf.filter((s) => s.type !== "null")
    if (rest.length === 1 && rest.length < anyOf.length) {
      const { anyOf: _drop, ...outer } = schema
      return { ...toGeminiSchema(rest[0]!), ...outer, nullable: true }
    }
    return { ...schema, anyOf: rest.map(toGeminiSchema) }
  }
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue
    if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, toGeminiSchema(v)]))
    } else if (key === "items") {
      out.items = toGeminiSchema(value as JsonSchema)
    } else {
      out[key] = value
    }
  }
  return out
}

const RETRY_DELAYS_MS = [5000, 15000, 30000]

/** Spaces request starts evenly so that at most INQUEST_LLM_RPM requests start per minute. */
let nextSlotAt = 0
async function waitForRateSlot(): Promise<void> {
  const rpm = CONFIG.llm.requestsPerMinute
  if (!rpm || rpm <= 0) return
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + 60_000 / rpm
  if (slot > now) await sleep(slot - now)
}

/** Provider errors worth retrying: overload (503), rate limit (429), timeouts. */
export function isTransient(message: string): boolean {
  return /(429|500|502|503|504|529)|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|rate.?limit|ECONNRESET|ETIMEDOUT/i.test(message)
}

export async function think<T>(opts: ThinkOptions<T>): Promise<ThinkResult<T>> {
  const state = runtimeState()
  const started = Date.now()
  const offline = async (note?: string): Promise<ThinkResult<T>> => {
    state.counters.llmOfflineCalls++
    if (CONFIG.llm.offlineLatencyMs > 0) await sleep(CONFIG.llm.offlineLatencyMs)
    return { value: opts.offline(), via: "offline", ms: Date.now() - started, note }
  }

  // Not worth a model call: answer by rules at once (no simulated latency, since no call would happen).
  if (opts.useLlm === false) return { value: opts.offline(), via: "offline", ms: Date.now() - started, note: "rules only" }
  if (!CONFIG.llm.enabled) return offline()
  if (CONFIG.llm.maxCallsPerRun > 0 && state.counters.llmCalls >= CONFIG.llm.maxCallsPerRun) {
    return offline("LLM call limit for this run reached (INQUEST_LLM_MAX_CALLS)")
  }
  if (opts.caseId !== undefined) {
    const used = callsPerCase.get(opts.caseId) ?? 0
    if (used >= CONFIG.llm.budgetPerCase) return offline("LLM budget for this case used up")
    callsPerCase.set(opts.caseId, used + 1)
  }

  await semaphore.acquire()
  try {
    state.counters.llmCalls++
    for (let attempt = 1; ; attempt++) {
      await waitForRateSlot()
      const text = await runWorker(opts)
      const parsed = JSON.parse(extractJson(text)) as T & { __inquest_error?: string }
      if (parsed && typeof parsed === "object" && "__inquest_error" in parsed) {
        const message = String(parsed.__inquest_error)
        // Overloaded or rate-limited provider: wait and try again before falling back.
        if (attempt < RETRY_DELAYS_MS.length + 1 && isTransient(message)) {
          await sleep(RETRY_DELAYS_MS[attempt - 1]! * (0.75 + Math.random() * 0.5))
          continue
        }
        throw new Error(message)
      }
      return { value: parsed, via: "llm", ms: Date.now() - started }
    }
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
    let settled = false
    const timer = setTimeout(() => settle(new Error(`timeout after ${CONFIG.llm.timeoutMs} ms`)), CONFIG.llm.timeoutMs)
    const settle = (error: Error | null, text?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(text ?? "")
    }
    // The worker leaves only once its loop has ended. Leaving earlier (e.g. on our own
    // timeout) makes Mozaik throw "Participant not found" when the late answer arrives.
    // Leave on the next tick: Mozaik delivers model.answer synchronously, and its cloud
    // exporter looks the agent up right after publishing that event.
    const loopEnded = () => {
      const done = worker
      if (!done) return
      worker = null
      setImmediate(() => {
        try {
          leave(done)
        } catch {
          /* already left */
        }
        state.roles.delete(done.getId())
      })
    }
    const finish = (error: Error | null, text?: string) => {
      loopEnded()
      settle(error, text)
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
    const model = opts.model === "smart" ? CONFIG.llm.modelSmart : CONFIG.llm.modelFast
    const gemini = isGemini(model)
    const looping: unknown = runLoop(worker.getId(), opts.prompt, {
      model,
      context: worker.getMemory().getContext(),
      structuredOutput: {
        name: opts.task.replace(/[^a-zA-Z0-9_]/g, "_"),
        schema: gemini ? toGeminiSchema(opts.schema) : opts.schema,
        strict: true,
      },
      // Gemini counts its thinking tokens against the output limit, so keep thinking short and the limit roomy.
      maxOutputTokens: gemini ? Math.max(opts.maxOutputTokens ?? 2000, 8000) : (opts.maxOutputTokens ?? 2000),
      ...(gemini ? { reasoningEffort: "low" } : {}),
    })
    if (looping instanceof Promise) {
      looping.catch((error: unknown) => {
        loopEnded()
        settle(error instanceof Error ? error : new Error(String(error)))
      })
    }
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
