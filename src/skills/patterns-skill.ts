/**
 * Institution-patterns agent skill: splitting, year-end spikes, repeated
 * objects, plans, round amounts (code) and expenses without a clear purpose
 * (code finds candidates, the LLM judges the description).
 */
import { REFERENCE } from "../config.js"
import type { Payment, SignalDraft } from "../domain/types.js"
import { LANGUAGE_RULES, bool, obj, str, think } from "../llm/think.js"
import { investigatePayerPatterns, paymentPatternSignals, vaguePurposeCandidate, vaguePurposeSignal, type PayerLead } from "../signals/patterns.js"

export async function screenPatterns(p: Payment, caseId?: number): Promise<SignalDraft[]> {
  const signals = paymentPatternSignals(p)
  const candidate = vaguePurposeCandidate(p)
  if (candidate.candidate) {
    const r = await think<{ vague: boolean; reason: string }>({
      role: "patterns",
      task: "judge_purpose",
      caseId,
      instruction: `You judge whether a public payment's description makes clear what the money was spent on. A description is vague when it does not let a citizen tell what was bought or done (e.g. "services", "various", "maintenance" with no object). A specific description names the goods, work or object. ${LANGUAGE_RULES}`,
      prompt: JSON.stringify({ description: p.description, category: REFERENCE.categories[p.category]?.label, amountRsd: p.amount }),
      schema: obj({ vague: bool(), reason: str("short reason, e.g. 'description is generic (\"Razne usluge\")'") }),
      offline: () => ({ vague: true, reason: candidate.reason }),
    })
    if (r.value.vague) signals.push(vaguePurposeSignal(p, r.value.reason || candidate.reason))
  }
  return signals
}

export function investigatePayer(payerId: string, from: string, to: string): { signals: SignalDraft[]; leads: PayerLead[]; examined: number } {
  return investigatePayerPatterns(payerId, from, to)
}
