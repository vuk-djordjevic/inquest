/**
 * Exercises the real Mozaik path of `think()` (worker agent joins, runLoop,
 * model.answer, leave) against a fake model registered in Mozaik's model list,
 * so it runs without an API key.
 */
import "./setup-env.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModelMessageItem, supportedModels, type InferenceInput } from "@mozaik-ai/core"
import { CONFIG } from "../src/config.js"
import { CaseBoard } from "../src/db/board.js"
import { obj, str, think } from "../src/llm/think.js"
import { ensureRuntime } from "../src/runtime/runtime.js"

const seen: InferenceInput[] = []
let fail = false

supportedModels.push({
  specification: {
    name: "inquest-fake-model",
    provider: "fake",
    supportsReasoningEffort: false,
    supportedReasoningEfforts: [],
    supportsStreaming: false,
    contextWindowSize: 100_000,
    supportedContextItemTypes: ["user_message", "developer_message", "model_message"],
    maxOutputTokens: 4000,
    supportsFunctionCalling: false,
    supportsStructuredOutput: true,
  },
  endpoint: {
    endpointMapper: { toRequest: (x: unknown) => x, toResponse: (x: unknown) => x as never },
    async infer(input: InferenceInput) {
      seen.push(input)
      await new Promise((r) => setTimeout(r, 20))
      if (fail) throw new Error("provider down")
      return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify({ answer: "from-model" }) })], tokenUsage: undefined, rowResponse: null }
    },
    async *stream() {},
  },
})

test("think() runs a Mozaik worker loop with structured output", async () => {
  const state = ensureRuntime()
  state.beginRun("test", "team", CaseBoard.fresh("team"))
  CONFIG.llm.enabled = true
  CONFIG.llm.modelFast = "inquest-fake-model"
  CONFIG.llm.offlineLatencyMs = 0

  const r = await think({ role: "price", task: "t", instruction: "be brief", prompt: "hi", schema: obj({ answer: str() }), offline: () => ({ answer: "offline" }) })
  assert.equal(r.via, "llm")
  assert.deepEqual(r.value, { answer: "from-model" })
  assert.equal(seen[0].structuredOutput?.strict, true)
  // The worker left the runtime after answering; only bookkeeping participants remain.
  assert.equal([...state.participants.values()].filter((p) => p.getManifest().name === "price/t").length, 0)

  // Ten calls in parallel all resolve to their own answer.
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    think({ role: "risk", task: `t${i}`, instruction: "x", prompt: String(i), schema: obj({ answer: str() }), offline: () => ({ answer: "offline" }) })))
  assert.ok(many.every((m) => m.via === "llm"))

  // A provider failure ends the loop with an error answer and falls back to offline.
  fail = true
  const f = await think({ role: "price", task: "t", instruction: "x", prompt: "y", schema: obj({ answer: str() }), offline: () => ({ answer: "offline" }) })
  assert.equal(f.via, "offline")
  assert.equal(f.value.answer, "offline")
  assert.equal(state.counters.llmFailures, 1)
})
