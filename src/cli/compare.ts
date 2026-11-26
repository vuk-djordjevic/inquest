/**
 * The jury comparison: the same payments processed twice - by the concurrent
 * agent team and by one agent working sequentially - with the same skills.
 * Writes runs/comparison.json for the dashboard.
 */
import { compare } from "../run/compare.js"
import { parseFilter } from "./args.js"

const result = await compare(parseFilter())
const t = result.team
const s = result.single
const row = (label: string, a: string | number, b: string | number) => console.log(`${label.padEnd(30)} ${String(a).padStart(14)} ${String(b).padStart(14)}`)
console.log(`\n${"".padEnd(30)} ${"agent team".padStart(14)} ${"single agent".padStart(14)}`)
row("payments", t.stats.payments, s.stats.payments)
row("wall time (s)", (t.stats.durationMs / 1000).toFixed(1), (s.stats.durationMs / 1000).toFixed(1))
row("flagged cases", t.stats.flaggedCases, s.stats.flaggedCases)
row("merged cases", t.stats.mergedCases, s.stats.mergedCases)
row("approved dossiers", t.stats.approvedDossiers, s.stats.approvedDossiers)
row("avg s to approved dossier", t.stats.avgSecondsToApprovedDossier ?? "-", s.stats.avgSecondsToApprovedDossier ?? "-")
if (t.evaluation && s.evaluation) {
  row("injected cases found", `${t.evaluation.detected}/${t.evaluation.injected}`, `${s.evaluation.detected}/${s.evaluation.injected}`)
  row("false alarms (clean)", `${t.evaluation.falseAlarms}/${t.evaluation.cleanPayments}`, `${s.evaluation.falseAlarms}/${s.evaluation.cleanPayments}`)
}
console.log(`\nSpeed-up: ${result.speedup.toFixed(1)}x  (LLM: ${t.stats.llm.enabled ? "online" : "offline, simulated latency"})`)
process.exit(0)
