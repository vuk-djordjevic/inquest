/**
 * Evaluation against the ground truth of injected test cases (agents never
 * read the truth file). Accuracy is measured only on injected cases; on the
 * rest of the data we report how much gets flagged.
 */
import { existsSync, readFileSync } from "node:fs"
import { CONFIG } from "../config.js"
import type { CaseBoard } from "../db/board.js"
import { sourceDb } from "../db/source.js"

interface TruthCase {
  id: string
  title: string
  clean?: boolean
  primarySignal?: string
  expectedSignals?: string[]
  paymentIds: string[]
}

export interface CaseResult {
  id: string
  title: string
  detected: boolean
  score: number | null
  caseIds: number[]
  primarySignal: string
  primaryFound: boolean
  expectedSignals: string[]
  foundSignals: string[]
}

export interface Evaluation {
  injected: number
  detected: number
  detectionRate: number
  correctSignal: number
  correctSignalRate: number
  expectedSignalRecall: number
  cleanPayments: number
  falseAlarms: number
  falseAlarmRate: number
  flaggedShare: { procurement: number; ledgers: number; real: number | null }
  verifierRejections: number
  verifierCorrections: number
  cases: CaseResult[]
  falseAlarmCases: Array<{ truthId: string; paymentId: string; caseId: number; score: number }>
  /** What the run covered: metrics only count payments that were actually screened. */
  scope: { screenedPayments: number; totalPayments: number; injectedOutOfScope: number; full: boolean }
}

export function loadTruth(): TruthCase[] {
  if (!existsSync(CONFIG.truthPath)) throw new Error(`Ground truth not found at ${CONFIG.truthPath}`)
  return (JSON.parse(readFileSync(CONFIG.truthPath, "utf-8")) as { cases: TruthCase[] }).cases
}

export function evaluate(board: CaseBoard): Evaluation {
  const truth = loadTruth()
  const th = CONFIG.investigation.flagThreshold
  const db = board.db

  const casesForPayment = (pid: string): number[] =>
    [...new Set((db.prepare(`SELECT case_id FROM case_payments WHERE payment_id = ?`).all(pid) as Array<{ case_id: number }>).map((r) => board.resolveCase(r.case_id)))]
  const caseScore = (id: number) => board.getCase(id)?.score ?? null
  const caseCodes = (id: number) => (db.prepare(`SELECT DISTINCT code FROM signals WHERE case_id = ?`).all(id) as Array<{ code: string }>).map((r) => r.code)

  // A run may cover only some institutions (e.g. the demo set): evaluate only what was screened.
  board.flushEvents()
  const screened = new Set(
    (db.prepare(`SELECT DISTINCT json_extract(payload_json, '$.paymentId') AS id FROM events WHERE type = 'contract.queued'`).all() as Array<{ id: string }>).map((r) => r.id),
  )
  const totalPayments = (sourceDb().prepare(`SELECT COUNT(*) AS n FROM payments`).get() as { n: number }).n
  const inScope = (t: TruthCase) => t.paymentIds.some((id) => screened.has(id))
  const injectedAll = truth.filter((x) => !x.clean)

  const results: CaseResult[] = []
  for (const t of injectedAll.filter(inScope)) {
    const caseIds = [...new Set(t.paymentIds.flatMap(casesForPayment))]
    const flaggedIds = caseIds.filter((id) => (caseScore(id) ?? 0) >= th)
    const found = [...new Set(flaggedIds.flatMap(caseCodes))]
    results.push({
      id: t.id,
      title: t.title,
      detected: flaggedIds.length > 0,
      score: flaggedIds.length ? Math.max(...flaggedIds.map((id) => caseScore(id) ?? 0)) : caseIds.length ? Math.max(...caseIds.map((id) => caseScore(id) ?? 0)) : null,
      caseIds,
      primarySignal: t.primarySignal ?? "",
      primaryFound: found.includes(t.primarySignal ?? ""),
      expectedSignals: t.expectedSignals ?? [],
      foundSignals: found,
    })
  }

  const falseAlarmCases: Evaluation["falseAlarmCases"] = []
  let cleanPayments = 0
  let falseAlarms = 0
  for (const t of truth.filter((x) => x.clean)) {
    for (const pid of t.paymentIds.filter((id) => screened.has(id))) {
      cleanPayments++
      const flagged = casesForPayment(pid).filter((id) => (caseScore(id) ?? 0) >= th)
      if (flagged.length) {
        falseAlarms++
        falseAlarmCases.push({ truthId: t.id, paymentId: pid, caseId: flagged[0], score: caseScore(flagged[0]) ?? 0 })
      }
    }
  }

  // Share of payments that end up in a flagged case, per source type.
  const flaggedPayments = new Set<string>()
  for (const c of board.listCases()) if ((c.score ?? 0) >= th) for (const pid of board.casePaymentIds(c.id)) flaggedPayments.add(pid)
  const share = (where: string) => {
    const ids = (sourceDb().prepare(`SELECT id FROM payments WHERE ${where}`).all() as Array<{ id: string }>).map((r) => r.id).filter((id) => screened.has(id))
    return ids.length ? ids.filter((id) => flaggedPayments.has(id)).length / ids.length : 0
  }
  const realCount = (sourceDb().prepare(`SELECT COUNT(*) AS n FROM payments WHERE dataset = 'real'`).get() as { n: number }).n

  let verifierRejections = 0
  let verifierCorrections = 0
  for (const row of db.prepare(`SELECT checks_json FROM dossiers WHERE status = 'rejected'`).all() as Array<{ checks_json: string }>) {
    const c = JSON.parse(row.checks_json ?? "null") as { rejections?: Array<{ corrected?: unknown }> } | null
    verifierRejections += c?.rejections?.length ?? 0
    verifierCorrections += c?.rejections?.filter((r) => r.corrected).length ?? 0
  }

  const detected = results.filter((r) => r.detected)
  const expectedTotal = results.reduce((s, r) => s + r.expectedSignals.length, 0)
  const expectedFound = results.reduce((s, r) => s + r.expectedSignals.filter((x) => r.foundSignals.includes(x)).length, 0)
  return {
    injected: results.length,
    detected: detected.length,
    detectionRate: results.length ? detected.length / results.length : 0,
    correctSignal: detected.filter((r) => r.primaryFound).length,
    correctSignalRate: detected.length ? detected.filter((r) => r.primaryFound).length / detected.length : 0,
    expectedSignalRecall: expectedTotal ? expectedFound / expectedTotal : 0,
    cleanPayments,
    falseAlarms,
    falseAlarmRate: cleanPayments ? falseAlarms / cleanPayments : 0,
    flaggedShare: {
      procurement: share(`source = 'procurement' AND dataset = 'synthetic'`),
      ledgers: share(`source != 'procurement' AND dataset = 'synthetic'`),
      real: realCount ? share(`dataset = 'real'`) : null,
    },
    verifierRejections,
    verifierCorrections,
    cases: results,
    falseAlarmCases,
    scope: {
      screenedPayments: screened.size,
      totalPayments,
      injectedOutOfScope: injectedAll.length - results.length,
      full: screened.size === totalPayments,
    },
  }
}

export function formatEvaluation(e: Evaluation): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines = [
    ...(e.scope.full ? [] : [`Scope: ${e.scope.screenedPayments} of ${e.scope.totalPayments} payments screened; ${e.scope.injectedOutOfScope} injected case(s) outside the run are not counted.`]),
    `Injected cases found:        ${e.detected}/${e.injected} (${pct(e.detectionRate)})`,
    `Correct signal type:         ${e.correctSignal}/${e.detected} (${pct(e.correctSignalRate)})`,
    `Expected signals recovered:  ${pct(e.expectedSignalRecall)}`,
    `False alarms on clean data:  ${e.falseAlarms}/${e.cleanPayments} payments (${pct(e.falseAlarmRate)})`,
    `Flagged share (synthetic):   procurement ${pct(e.flaggedShare.procurement)}, ledgers ${pct(e.flaggedShare.ledgers)}${e.flaggedShare.real !== null ? `, real ${pct(e.flaggedShare.real)}` : ""}`,
    `Verifier:                    ${e.verifierRejections} rejected claim(s), ${e.verifierCorrections} corrected from source`,
    "",
    ...e.cases.map((c) => `  ${c.detected ? "✔" : "✘"} ${c.id} ${c.title.slice(0, 70).padEnd(70)} score=${c.score?.toFixed(2) ?? "-"} primary=${c.primarySignal}${c.primaryFound ? "" : " (missing)"} found=[${c.foundSignals.join(",")}]`),
  ]
  if (e.falseAlarmCases.length) lines.push("", "False alarms:", ...e.falseAlarmCases.map((f) => `  ${f.truthId} ${f.paymentId} -> case #${f.caseId} (${f.score.toFixed(2)})`))
  return lines.join("\n")
}
