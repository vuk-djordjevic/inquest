/** Run statistics shared by the team run and the single-agent baseline. */
import { CONFIG } from "../config.js"
import type { CaseBoard } from "../db/board.js"
import type { RunCounters } from "../runtime/runtime.js"
import { webMode } from "../tools/web.js"

export interface RunStats {
  runId: string
  mode: "team" | "single"
  payments: number
  durationMs: number
  cases: number
  flaggedCases: number
  approvedDossiers: number
  mergedCases: number
  signals: Record<string, number>
  rejectedDossierVersions: number
  correctedFacts: number
  avgSecondsToApprovedDossier: number | null
  llm: { enabled: boolean; modelFast: string; modelSmart: string } & Pick<RunCounters, "llmCalls" | "llmOfflineCalls" | "llmFailures" | "inputTokens" | "outputTokens">
  web: { mode: string; searches: number; pages: number }
  events: number
}

export function collectStats(board: CaseBoard, runId: string, mode: "team" | "single", payments: number, durationMs: number, counters: RunCounters): RunStats {
  board.flushEvents()
  const db = board.db
  const one = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T
  const cases = one<{ n: number }>(`SELECT COUNT(*) AS n FROM cases WHERE status != 'merged'`).n
  const flagged = one<{ n: number }>(`SELECT COUNT(*) AS n FROM cases WHERE status != 'merged' AND score >= ?`, CONFIG.investigation.flagThreshold).n
  const approved = one<{ n: number }>(`SELECT COUNT(*) AS n FROM cases WHERE status = 'approved'`).n
  const merged = one<{ n: number }>(`SELECT COUNT(*) AS n FROM cases WHERE status = 'merged' AND merge_reason != 'closed'`).n
  const rejected = one<{ n: number }>(`SELECT COUNT(*) AS n FROM dossiers WHERE status = 'rejected'`).n
  const signals = Object.fromEntries(
    (db.prepare(`SELECT code, COUNT(*) AS n FROM signals GROUP BY code ORDER BY n DESC`).all() as Array<{ code: string; n: number }>).map((r) => [r.code, r.n]),
  )
  let correctedFacts = 0
  for (const row of db.prepare(`SELECT checks_json FROM dossiers WHERE status = 'rejected'`).all() as Array<{ checks_json: string }>) {
    const checks = JSON.parse(row.checks_json ?? "null") as { rejections?: Array<{ corrected?: unknown }> } | null
    correctedFacts += checks?.rejections?.filter((r) => r.corrected).length ?? 0
  }
  // Time from the root payment entering the queue to an approved dossier.
  const times = db
    .prepare(
      `SELECT c.approved_at_ms - MIN(e.at_ms) AS ms FROM cases c
       JOIN events e ON e.type = 'contract.queued' AND json_extract(e.payload_json, '$.paymentId') = c.root_payment_id
       WHERE c.status = 'approved' GROUP BY c.id`,
    )
    .all() as Array<{ ms: number }>
  const avg = times.length ? times.reduce((s, t) => s + t.ms, 0) / times.length / 1000 : null
  return {
    runId,
    mode,
    payments,
    durationMs,
    cases,
    flaggedCases: flagged,
    approvedDossiers: approved,
    mergedCases: merged,
    signals,
    rejectedDossierVersions: rejected,
    correctedFacts,
    avgSecondsToApprovedDossier: avg === null ? null : Math.round(avg * 10) / 10,
    llm: {
      enabled: CONFIG.llm.enabled,
      modelFast: CONFIG.llm.modelFast,
      modelSmart: CONFIG.llm.modelSmart,
      llmCalls: counters.llmCalls,
      llmOfflineCalls: counters.llmOfflineCalls,
      llmFailures: counters.llmFailures,
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
    },
    web: { mode: webMode(), searches: counters.webSearches, pages: counters.webPages },
    events: one<{ n: number }>(`SELECT COUNT(*) AS n FROM events`).n,
  }
}
