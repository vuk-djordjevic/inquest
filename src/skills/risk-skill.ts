/**
 * Risk-assessment agent skill. Combines the signals of a case into a score:
 * a code baseline (independent signals combine like probabilities, signals from
 * several agents converging add weight), then the LLM looks for a legitimate
 * explanation and may lower the score within fixed bounds.
 */
import { CONFIG } from "../config.js"
import type { CaseBoard } from "../db/board.js"
import { getPayments } from "../db/source.js"
import { SIGNALS } from "../domain/signal-catalog.js"
import { LANGUAGE_RULES, nullable, num, obj, reportLanguageInstruction, str, think } from "../llm/think.js"
import { clamp, round } from "../signals/stats.js"
import { EXPLANATION_HINTS, findExplanation } from "./explanations.js"

export interface CaseScore {
  score: number
  baseline: number
  adjustment: number
  rationale: string
  explanation: string | null
  flagged: boolean
}

export async function scoreCase(board: CaseBoard, caseId: number): Promise<CaseScore> {
  const c = board.getCase(caseId)!
  const signals = board.caseSignals(caseId)
  const findings = board.caseFindings(caseId)
  const payments = getPayments(board.casePaymentIds(caseId))

  const strongestByCode = new Map<string, number>()
  for (const s of signals) strongestByCode.set(s.code, Math.max(strongestByCode.get(s.code) ?? 0, s.strength))
  const combined = 1 - [...strongestByCode.values()].reduce((acc, s) => acc * (1 - s), 1)
  const agents = new Set(signals.map((s) => s.agent))
  const agentBonus = agents.size >= 3 ? 0.08 : agents.size === 2 ? 0.04 : 0
  const convergenceBonus = c.priority > 0 || new Set(findings.map((f) => f.agent)).size >= 2 ? 0.06 : 0
  const baseline = clamp(combined + agentBonus + convergenceBonus)
  const alreadyExplained = signals.some((s) => s.explanation)

  const r = await think<{ legitimateExplanation: string | null; adjustment: number; rationale: string }>({
    role: "risk",
    task: "assess_case",
    model: "smart",
    caseId,
    // The adjustment is at most +0.1, so a case that cannot reach the flag threshold
    // even with it is scored by the rules alone (saves most calls on real data).
    useLlm: baseline + 0.1 >= CONFIG.investigation.flagThreshold,
    instruction: `You are the Risk-assessment agent. You receive the risk signals found for one case of public spending, computed by rules. A single signal means little; several signals on the same payer or recipient mean more. Your job: (1) check whether the payment descriptions contain a legitimate explanation that the rules could not see (examples: ${EXPLANATION_HINTS.join("; ")}), ignoring explanations already recorded on a signal; (2) choose an adjustment between -0.3 (fully explained) and +0.1 (signals reinforce each other in a way the rules undercount); (3) write a 2-3 sentence rationale. ${LANGUAGE_RULES} ${reportLanguageInstruction()}`,
    prompt: JSON.stringify({
      baselineScore: round(baseline, 2),
      signals: signals.map((s) => ({ signal: SIGNALS[s.code].name, strength: s.strength, summary: s.summary, explanationAlreadyApplied: s.explanation })),
      branchFindings: findings.map((f) => f.summary),
      payments: payments.slice(0, 25).map((p) => ({ date: p.date, amount: p.amount, recipient: p.recipient_name, description: p.description })),
    }),
    schema: obj({
      legitimateExplanation: nullable(str()),
      adjustment: num("between -0.3 and 0.1"),
      rationale: str(),
    }),
    offline: () => {
      const e = alreadyExplained ? null : findExplanation(payments)
      const codes = [...strongestByCode.keys()].map((k) => SIGNALS[k as keyof typeof SIGNALS].name.toLowerCase())
      return {
        legitimateExplanation: e,
        adjustment: e ? -0.25 : 0,
        rationale: `${signals.length} signal(s) from ${agents.size} agent(s): ${codes.join(", ")}.${convergenceBonus ? " Independent lines of investigation reached the same entities." : ""}${e ? ` A legitimate explanation lowers the score: ${e}.` : ""}`,
      }
    },
  })
  const adjustment = clamp(r.value.adjustment, -0.3, 0.1)
  const score = round(clamp(baseline + adjustment), 3)
  return {
    score,
    baseline: round(baseline, 3),
    adjustment,
    rationale: r.value.rationale,
    explanation: r.value.legitimateExplanation,
    flagged: score >= CONFIG.investigation.flagThreshold,
  }
}
