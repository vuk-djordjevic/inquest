/** Institution-pattern signal formulas: splitting, spikes, repeats, plans, vague descriptions. */
import { REFERENCE, categoryGroup } from "../config.js"
import { getBudgetPlan, getProcurementContext, paymentsByPayer, procedureTypesByPayer } from "../db/source.js"
import type { Payment, SignalDraft } from "../domain/types.js"
import { daysBetween, formatRsd, round } from "./stats.js"

export const LEDGER_SPLIT_BAND = 0.9 // payments within 10% below the approval threshold
export const PROCUREMENT_SPLIT_BAND = 0.97 // purchases within 3% below the exemption threshold
export const LEDGER_SPLIT_WINDOW_DAYS = 31
export const PROCUREMENT_SPLIT_WINDOW_DAYS = 92
export const REPEAT_WINDOW_DAYS = 730
export const OVER_PLAN_TOLERANCE = 1.1
export const NONCOMPETITIVE_SHARE_THRESHOLD = 0.3

const completed = (p: Payment) => p.status === "completed"

/** Group date-sorted payments into clusters whose consecutive gaps are <= maxGap days. */
function clusters(payments: Payment[], maxGapDays: number): Payment[][] {
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const out: Payment[][] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && daysBetween(last[last.length - 1].date, p.date) <= maxGapDays) last.push(p)
    else out.push([p])
  }
  return out
}

function dominantRecipient(payments: Payment[]): { id: string; share: number } | null {
  const counts = new Map<string, number>()
  for (const p of payments) counts.set(p.recipient_id, (counts.get(p.recipient_id) ?? 0) + 1)
  const [id, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
  return id ? { id, share: n / payments.length } : null
}

// -----------------------------------------------------------------------------
// SPLIT: several payments just below an approval threshold (ledger) or
// several direct purchases just below the procurement threshold (OCP R011).
// -----------------------------------------------------------------------------
export function splitSignal(p: Payment): SignalDraft | null {
  if (!completed(p)) return null
  if (p.source === "procurement") return procurementSplitSignal(p)
  const threshold = REFERENCE.approvalThresholdsRsd[p.payer_kind]
  if (!threshold || p.amount < threshold * LEDGER_SPLIT_BAND || p.amount >= threshold) return null
  const inBand = paymentsByPayer(p.payer_id)
    .filter((x) => completed(x) && x.recipient_id === p.recipient_id && x.amount >= threshold * LEDGER_SPLIT_BAND && x.amount < threshold)
  const cluster = clusters(inBand, LEDGER_SPLIT_WINDOW_DAYS).find((c) => c.some((x) => x.id === p.id))
  if (!cluster || cluster.length < 3) return null
  const total = cluster.reduce((s, x) => s + x.amount, 0)
  return {
    code: "SPLIT", agent: "patterns",
    strength: Math.min(0.7, 0.5 + 0.05 * (cluster.length - 3)),
    summary: `${cluster.length} payments to the same recipient between ${cluster[0].date} and ${cluster[cluster.length - 1].date}, each just below the ${formatRsd(threshold)} approval threshold (total ${formatRsd(total)}).`,
    rule: `>= 3 payments to one recipient within ${LEDGER_SPLIT_WINDOW_DAYS} days, each in [${Math.round(LEDGER_SPLIT_BAND * 100)}%, 100%) of the approval threshold`,
    payerId: p.payer_id, recipientId: p.recipient_id,
    paymentIds: cluster.map((x) => x.id),
    facts: [{ kind: "payments_in_window", payerId: p.payer_id, recipientId: p.recipient_id, paymentIds: cluster.map((x) => x.id), count: cluster.length, total }],
    key: `SPLIT|${cluster[0].id}`,
  }
}

function exemptionThreshold(contractKind: string | null): number {
  return REFERENCE.procurementExemptionThresholdRsd[contractKind ?? "goods"] ?? REFERENCE.procurementExemptionThresholdRsd.goods
}

function procurementSplitSignal(p: Payment): SignalDraft | null {
  const ctx = getProcurementContext(p.id)
  if (!ctx || ctx.procedure_type !== "direct") return null
  const threshold = exemptionThreshold(ctx.contract_kind)
  const inBand = (x: Payment) => x.amount >= threshold * PROCUREMENT_SPLIT_BAND && x.amount < threshold
  if (!inBand(p)) return null
  const group = categoryGroup(p.category)
  const candidates = paymentsByPayer(p.payer_id, { group }).filter(
    (x) => completed(x) && inBand(x) && getProcurementContext(x.id)?.procedure_type === "direct",
  )
  const cluster = clusters(candidates, PROCUREMENT_SPLIT_WINDOW_DAYS).find((c) => c.some((x) => x.id === p.id))
  if (!cluster || cluster.length < 3) return null
  const dom = dominantRecipient(cluster)
  const recipientId = dom && dom.share >= 0.6 ? dom.id : null
  const total = cluster.reduce((s, x) => s + x.amount, 0)
  const domCount = recipientId ? cluster.filter((x) => x.recipient_id === recipientId).length : 0
  return {
    code: "SPLIT", agent: "patterns", strength: 0.6,
    summary: `${cluster.length} direct purchases of ${group.replace("_", " ")} between ${cluster[0].date} and ${cluster[cluster.length - 1].date}, each 0-3% below the ${formatRsd(threshold)} procurement threshold${recipientId ? `; ${domCount} of ${cluster.length} went to the same supplier` : ""}.`,
    rule: `>= 3 direct purchases of one category group within ~3 months, each in [${Math.round(PROCUREMENT_SPLIT_BAND * 100)}%, 100%) of the exemption threshold (OCP R011)`,
    payerId: p.payer_id, recipientId,
    paymentIds: cluster.map((x) => x.id),
    facts: [{ kind: "payments_in_window", payerId: p.payer_id, recipientId, paymentIds: cluster.map((x) => x.id), count: recipientId ? domCount : cluster.length, total }],
    key: `SPLIT|${cluster[0].id}`,
  }
}

// -----------------------------------------------------------------------------
// REPEATED_OBJECT: the same object paid for the same kind of work >= 3 times in 2 years.
// -----------------------------------------------------------------------------
export function repeatedObjectSignal(p: Payment): SignalDraft | null {
  if (!p.object_ref || !completed(p)) return null
  const same = paymentsByPayer(p.payer_id, { category: p.category }).filter((x) => completed(x) && x.object_ref === p.object_ref)
  const within = same.filter((x) => Math.abs(daysBetween(p.date, x.date)) <= REPEAT_WINDOW_DAYS)
  if (within.length < 3) return null
  const recipients = new Set(within.map((x) => x.recipient_id))
  const total = within.reduce((s, x) => s + x.amount, 0)
  const sameRecipient = recipients.size === 1
  return {
    code: "REPEATED_OBJECT", agent: "patterns", strength: sameRecipient ? 0.65 : 0.55,
    summary: `"${p.object_ref}" was paid for ${within.length} times for ${REFERENCE.categories[p.category]?.label.toLowerCase() ?? p.category} between ${within[0].date} and ${within[within.length - 1].date}, ${formatRsd(total)} in total${sameRecipient ? ", always to the same recipient" : ""}.`,
    rule: `same object and category paid >= 3 times within ${REPEAT_WINDOW_DAYS} days`,
    payerId: p.payer_id, recipientId: sameRecipient ? p.recipient_id : null,
    paymentIds: within.map((x) => x.id),
    facts: [{ kind: "object_repeats", payerId: p.payer_id, objectRef: p.object_ref, category: p.category, count: within.length, total }],
    key: `REPEATED_OBJECT|${p.payer_id}|${p.object_ref}|${p.category}`,
  }
}

// -----------------------------------------------------------------------------
// VAGUE_PURPOSE: the code finds candidates; the LLM (or the offline rule) judges.
// -----------------------------------------------------------------------------
const GENERIC_DESCRIPTIONS = new Set([
  "usluge", "razne usluge", "ostale usluge", "ostalo", "razno", "održavanje", "odrzavanje", "troškovi", "troskovi",
  "materijal", "roba", "radovi", "services", "various services", "other", "misc", "miscellaneous", "maintenance",
])
export const VAGUE_MIN_AMOUNT = 40_000

export function vaguePurposeCandidate(p: Payment): { candidate: boolean; reason: string } {
  // Ledger payments only: a procurement has a CPV code and tender documents, so a short
  // lot title ("Gorivo", "Lekovi") is normal there and says nothing about the purpose.
  if (p.source === "procurement" || !completed(p) || p.amount < VAGUE_MIN_AMOUNT) return { candidate: false, reason: "" }
  const text = (p.description ?? "").trim().toLowerCase().replace(/[.,;:!"']/g, "")
  if (!text) return { candidate: true, reason: "description is empty" }
  if (GENERIC_DESCRIPTIONS.has(text)) return { candidate: true, reason: `description is generic ("${p.description}")` }
  if (text.split(/\s+/).length <= 1 && !/\d/.test(text)) return { candidate: true, reason: `one-word description ("${p.description}")` }
  return { candidate: false, reason: "" }
}

export function vaguePurposeSignal(p: Payment, reason: string): SignalDraft {
  return {
    code: "VAGUE_PURPOSE", agent: "patterns", strength: p.amount >= 300_000 ? 0.55 : 0.35,
    summary: `Payment of ${formatRsd(p.amount)} has no clear purpose: ${reason}.`,
    rule: "description empty, generic or not specific enough to tell what was bought",
    payerId: p.payer_id, recipientId: p.recipient_id, paymentIds: [p.id],
    facts: [{ kind: "payment_amount", paymentId: p.id, amount: p.amount }, { kind: "description", paymentId: p.id, text: p.description ?? "" }],
    key: `VAGUE_PURPOSE|${p.id}`,
  }
}

// -----------------------------------------------------------------------------
// ROUND_REPEATED: many identical round amounts to one recipient.
// -----------------------------------------------------------------------------
export function roundRepeatedSignal(p: Payment): SignalDraft | null {
  if (!completed(p) || p.amount < 10_000 || p.amount % 10_000 !== 0) return null
  const same = paymentsByPayer(p.payer_id).filter((x) => completed(x) && x.recipient_id === p.recipient_id && x.amount === p.amount)
  if (same.length < 6) return null
  return {
    code: "ROUND_REPEATED", agent: "patterns", strength: 0.5,
    summary: `${same.length} payments of exactly ${formatRsd(p.amount)} to the same recipient between ${same[0].date} and ${same[same.length - 1].date}.`,
    rule: ">= 6 identical round amounts (multiple of 10,000 RSD) from one payer to one recipient",
    payerId: p.payer_id, recipientId: p.recipient_id, paymentIds: same.map((x) => x.id),
    facts: [{ kind: "identical_amounts", payerId: p.payer_id, recipientId: p.recipient_id, amount: p.amount, count: same.length }],
    key: `ROUND_REPEATED|${p.payer_id}|${p.recipient_id}|${p.amount}`,
  }
}

// -----------------------------------------------------------------------------
// YEAR_END_SPIKE: December share of a category's annual spending.
// -----------------------------------------------------------------------------
export function yearEndSpikeSignal(p: Payment): SignalDraft | null {
  if (!completed(p) || p.date.slice(5, 7) !== "12" || REFERENCE.categories[p.category]?.naturalMonopoly) return null
  const year = Number(p.date.slice(0, 4))
  const inYear = paymentsByPayer(p.payer_id, { category: p.category, from: `${year}-01-01`, to: `${year}-12-31` }).filter(completed)
  if (inYear.length < 6) return null
  const total = inYear.reduce((s, x) => s + x.amount, 0)
  const dec = inYear.filter((x) => x.date.slice(5, 7) === "12")
  const decTotal = dec.reduce((s, x) => s + x.amount, 0)
  const otherMonthlyAvg = (total - decTotal) / 11
  const share = decTotal / total
  if (share < 0.4 || decTotal < 3 * otherMonthlyAvg) return null
  return {
    code: "YEAR_END_SPIKE", agent: "patterns", strength: share >= 0.5 ? 0.55 : 0.45,
    summary: `${round(share * 100)}% of the ${year} spending on ${REFERENCE.categories[p.category]?.label.toLowerCase() ?? p.category} (${formatRsd(decTotal)} of ${formatRsd(total)}) was paid in December.`,
    rule: "December share >= 40% of the annual category spending and >= 3x the average of the other months",
    payerId: p.payer_id, recipientId: null, paymentIds: dec.map((x) => x.id),
    facts: [{ kind: "december_share", payerId: p.payer_id, category: p.category, year, sharePct: round(share * 100, 1) }],
    key: `YEAR_END_SPIKE|${p.payer_id}|${p.category}|${year}`,
  }
}

// -----------------------------------------------------------------------------
// OVER_PLAN: paid more than the planned budget line.
// -----------------------------------------------------------------------------
export function overPlanSignal(p: Payment): SignalDraft | null {
  if (!completed(p)) return null
  const year = Number(p.date.slice(0, 4))
  const planned = getBudgetPlan(p.payer_id, p.category, year)
  if (!planned) return null
  const inYear = paymentsByPayer(p.payer_id, { category: p.category, from: `${year}-01-01`, to: `${year}-12-31` }).filter(completed)
  const spent = inYear.reduce((s, x) => s + x.amount, 0)
  if (spent <= planned * OVER_PLAN_TOLERANCE) return null
  let cumulative = 0
  const over: string[] = []
  for (const x of inYear) {
    cumulative += x.amount
    if (cumulative > planned) over.push(x.id)
  }
  const ratio = spent / planned
  return {
    code: "OVER_PLAN", agent: "patterns", strength: ratio >= 1.5 ? 0.6 : 0.45,
    summary: `${year} plan for ${REFERENCE.categories[p.category]?.label.toLowerCase() ?? p.category} was ${formatRsd(planned)}; ${formatRsd(spent)} was paid (${round(ratio * 100)}% of plan).`,
    rule: `sum of payments in the budget line > ${Math.round(OVER_PLAN_TOLERANCE * 100)}% of the planned amount`,
    payerId: p.payer_id, recipientId: null, paymentIds: over,
    facts: [{ kind: "plan_vs_spent", payerId: p.payer_id, category: p.category, year, planned, spent }],
    key: `OVER_PLAN|${p.payer_id}|${p.category}|${year}`,
  }
}

// -----------------------------------------------------------------------------
// NONCOMPETITIVE_SHARE (OCP R013): share of negotiated procedures of a buyer.
// -----------------------------------------------------------------------------
export function noncompetitiveShareSignal(payerId: string): SignalDraft | null {
  const procs = procedureTypesByPayer(payerId).filter((r) => r.procedure_type && r.procedure_type !== "direct" && r.status === "completed")
  if (procs.length < 10) return null
  const limited = procs.filter((r) => r.procedure_type === "limited")
  const share = limited.length / procs.length
  if (share < NONCOMPETITIVE_SHARE_THRESHOLD) return null
  return {
    code: "NONCOMPETITIVE_SHARE", agent: "patterns", strength: share >= 0.4 ? 0.55 : 0.45,
    summary: `${limited.length} of ${procs.length} procedures above the threshold (${round(share * 100)}%) were negotiated without a public call.`,
    rule: `share of non-competitive procedures >= ${NONCOMPETITIVE_SHARE_THRESHOLD * 100}% (OCP R013)`,
    payerId, recipientId: null, paymentIds: limited.map((r) => r.payment_id),
    facts: [{ kind: "noncompetitive_share", payerId, noncompetitive: limited.length, total: procs.length }],
    key: `NONCOMPETITIVE_SHARE|${payerId}`,
  }
}

/** Per-payment pattern checks (cheap code). VAGUE_PURPOSE is handled by the agent because it needs judgment. */
export function paymentPatternSignals(p: Payment): SignalDraft[] {
  const out: SignalDraft[] = []
  for (const check of [splitSignal, repeatedObjectSignal, roundRepeatedSignal, yearEndSpikeSignal, overPlanSignal]) {
    const s = check(p)
    if (s) out.push(s)
  }
  if (p.source === "procurement" && getProcurementContext(p.id)?.procedure_type === "limited") {
    const s = noncompetitiveShareSignal(p.payer_id)
    if (s) out.push(s)
  }
  return out
}

export interface PayerLead {
  recipientId: string
  recipientName: string
  group: string
  share: number
  count: number
}

/**
 * Branch investigation of a payer: run every pattern check across all of its
 * payments in the window and report recipients that dominate a category group
 * (leads for the Recipient network agent).
 */
export function investigatePayerPatterns(payerId: string, from: string, to: string): { signals: SignalDraft[]; leads: PayerLead[]; examined: number } {
  const payments = paymentsByPayer(payerId, { from, to })
  const byKey = new Map<string, SignalDraft>()
  for (const p of payments) for (const s of paymentPatternSignals(p)) byKey.set(s.key, s)
  const nc = noncompetitiveShareSignal(payerId)
  if (nc) byKey.set(nc.key, nc)

  const leads: PayerLead[] = []
  const byGroup = new Map<string, Payment[]>()
  for (const p of payments.filter(completed)) {
    if (REFERENCE.categories[p.category]?.naturalMonopoly) continue
    const g = categoryGroup(p.category)
    byGroup.set(g, [...(byGroup.get(g) ?? []), p])
  }
  for (const [group, list] of byGroup) {
    if (list.length < 4) continue
    const dom = dominantRecipient(list)
    if (dom && dom.share >= 0.6) {
      const name = list.find((x) => x.recipient_id === dom.id)?.recipient_name ?? dom.id
      leads.push({ recipientId: dom.id, recipientName: name, group, share: dom.share, count: list.length })
    }
  }
  return { signals: [...byKey.values()], leads, examined: payments.length }
}
