import { CONFIG } from "../config.js"
import type { CaseBoard } from "../db/board.js"
import type { RunStats } from "../run/stats.js"

export function printStats(s: RunStats): void {
  console.log(`\n=== ${s.mode === "team" ? "Agent team (concurrent)" : "Single agent (sequential)"} — ${s.runId}`)
  console.log(`payments: ${s.payments}  time: ${(s.durationMs / 1000).toFixed(1)} s  events: ${s.events}`)
  console.log(`cases: ${s.cases}  flagged: ${s.flaggedCases}  approved dossiers: ${s.approvedDossiers}  merged cases: ${s.mergedCases}`)
  console.log(`verifier: ${s.rejectedDossierVersions} rejected dossier version(s), ${s.correctedFacts} fact(s) corrected`)
  console.log(`avg time to approved dossier: ${s.avgSecondsToApprovedDossier ?? "-"} s`)
  console.log(`LLM: ${s.llm.enabled ? `${s.llm.modelFast} / ${s.llm.modelSmart}` : "offline (deterministic fallbacks)"}  calls: ${s.llm.llmCalls}  offline: ${s.llm.llmOfflineCalls}  failed: ${s.llm.llmFailures}  tokens: ${s.llm.inputTokens}/${s.llm.outputTokens}`)
  console.log(`web: ${s.web.mode}  searches: ${s.web.searches}  pages: ${s.web.pages}`)
  console.log(`signals: ${Object.entries(s.signals).map(([k, v]) => `${k}=${v}`).join(" ")}`)
}

export function printCases(board: CaseBoard, top = 15): void {
  const cases = board.listCases().filter((c) => (c.score ?? 0) >= CONFIG.investigation.flagThreshold).slice(0, top)
  console.log(`\nTop flagged cases:`)
  for (const c of cases) {
    const codes = [...new Set(board.caseSignals(c.id).map((s) => s.code))].join(", ")
    console.log(`  #${String(c.id).padEnd(4)} ${((c.score ?? 0) * 100).toFixed(0).padStart(3)}  ${c.status.padEnd(8)} ${c.title.slice(0, 60).padEnd(60)} ${codes}`)
  }
}
