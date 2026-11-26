/**
 * Team run: all agents join the Mozaik runtime and work concurrently, driven
 * only by events. The run is over when no work is in flight anywhere.
 */
import type { Participant } from "@mozaik-ai/core"
import { CaseBoard } from "../db/board.js"
import { listPaymentIds, type PaymentFilter } from "../db/source.js"
import { createCoordinator } from "../agents/coordinator.js"
import { createRecorder } from "../agents/recorder.js"
import { createRiskAgent, createVerifierAgent, createWriterAgent } from "../agents/review-agents.js"
import { createNetworkAgent, createPatternsAgent, createPriceAgent, createProcedureAgent } from "../agents/signal-agents.js"
import { CONFIG } from "../config.js"
import { llmEnabled, resetLlmBudget } from "../llm/think.js"
import { EV, type RunStarted } from "../runtime/events.js"
import { emit, ensureRuntime, join, leave, type InquestState } from "../runtime/runtime.js"
import { resetRegistryMemo } from "../skills/network-skill.js"
import { resetPriceBudget } from "../skills/price-skill.js"
import { webMode } from "../tools/web.js"
import { collectStats, type RunStats } from "./stats.js"

let running = false
export function isRunning(): boolean {
  return running
}

/** Resolve once nothing has been in flight for `quietMs`. */
export function waitForSettle(state: InquestState, quietMs = 300): Promise<void> {
  return new Promise((resolve) => {
    let quietSince: number | null = null
    const timer = setInterval(() => {
      if (state.inflight.size === 0) {
        quietSince ??= Date.now()
        if (Date.now() - quietSince >= quietMs) {
          clearInterval(timer)
          resolve()
        }
      } else quietSince = null
    }, 50)
  })
}

export async function runTeam(filter: PaymentFilter = {}): Promise<RunStats> {
  if (running) throw new Error("A run is already in progress")
  running = true
  const participants: Participant[] = []
  try {
    const state = ensureRuntime()
    const board = CaseBoard.fresh("team")
    const runId = `team-${new Date().toISOString().replace(/[:.]/g, "-")}`
    state.beginRun(runId, "team", board)
    board.startRun(runId, "team")
    resetLlmBudget()
    resetPriceBudget()
    resetRegistryMemo()

    const recorder = createRecorder()
    join(recorder)
    participants.push(recorder)
    const coordinator = createCoordinator()
    const team = [
      coordinator.agent,
      createPriceAgent(),
      createProcedureAgent(),
      createPatternsAgent(),
      createNetworkAgent(),
      createRiskAgent(),
      createWriterAgent(),
      createVerifierAgent(),
    ]
    for (const a of team) {
      join(a)
      participants.push(a)
    }

    const ids = listPaymentIds(filter)
    emit<RunStarted>(coordinator.agent, EV.runStarted, { runId, mode: "team", payments: ids.length, llm: llmEnabled(), web: webMode() })
    const started = Date.now()
    const queued = coordinator.queue(ids)
    await waitForSettle(state)
    await queued
    const stats = collectStats(board, runId, "team", ids.length, Date.now() - started, state.counters)
    emit(coordinator.agent, EV.runSettled, stats)
    board.finishRun(runId, stats)
    if (CONFIG.llm.enabled && stats.llm.llmFailures > 0) console.warn(`[team] ${stats.llm.llmFailures} LLM call(s) failed and used offline fallbacks`)
    return stats
  } finally {
    for (const p of participants.reverse()) {
      try {
        leave(p)
      } catch {
        /* ignore */
      }
    }
    running = false
  }
}
