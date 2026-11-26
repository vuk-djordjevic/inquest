/** Recipient-network signal formulas: concentration, new recipients, activity mismatch. */
import { REFERENCE, categoryGroup } from "../config.js"
import { paymentsByPayer, paymentsByRecipient } from "../db/source.js"
import type { Payment, RegistryRecord, SignalDraft } from "../domain/types.js"
import { daysBetween, formatRsd, round } from "./stats.js"

export const NEW_RECIPIENT_DAYS = 90
export const CONCENTRATION_SHARE = 0.6
export const CONCENTRATION_MIN_COUNT = 4

/** NEW_RECIPIENT: recipient founded shortly before its first payment from public money. */
export function newRecipientSignal(p: Payment, record: RegistryRecord): SignalDraft | null {
  if (!record.foundedOn) return null
  const all = paymentsByRecipient(p.recipient_id).filter((x) => x.status === "completed")
  if (!all.length) return null
  const first = all[0]
  const days = daysBetween(record.foundedOn, first.date)
  if (days < 0 || days > NEW_RECIPIENT_DAYS) return null
  const total = all.reduce((s, x) => s + x.amount, 0)
  return {
    code: "NEW_RECIPIENT", agent: "network", strength: total >= 1_000_000 ? 0.6 : 0.45,
    summary: `${p.recipient_name} was registered on ${record.foundedOn}, ${days} days before its first payment (${first.date}); it has received ${formatRsd(total)} in total.`,
    rule: `first payment within ${NEW_RECIPIENT_DAYS} days of the recipient's registration date`,
    payerId: first.payer_id, recipientId: p.recipient_id, paymentIds: all.map((x) => x.id),
    facts: [
      { kind: "registry", recipientId: p.recipient_id, foundedOn: record.foundedOn, activityCode: record.activityCode, activity: record.activity, sourceUrl: record.sourceUrl },
      { kind: "first_payment_after_founding", recipientId: p.recipient_id, days },
    ],
    key: `NEW_RECIPIENT|${p.recipient_id}`,
  }
}

/** Code-level check: is the registered activity outside the plausible list for this category? */
export function activityMismatchCandidate(p: Payment, record: RegistryRecord): boolean {
  const allowed = REFERENCE.allowedActivityPrefixes[p.category]
  if (!allowed || !record.activityCode) return false
  return !allowed.includes(record.activityCode.slice(0, 2))
}

export function unusualRecipientSignal(p: Payment, record: RegistryRecord, judgment: string): SignalDraft {
  return {
    code: "UNUSUAL_RECIPIENT", agent: "network", strength: 0.55,
    summary: `${p.recipient_name} is registered for "${record.activity}" (${record.activityCode}) but was paid ${formatRsd(p.amount)} for ${REFERENCE.categories[p.category]?.label.toLowerCase() ?? p.category}. ${judgment}`.trim(),
    rule: "registered activity of the recipient does not plausibly supply the purchased category",
    payerId: p.payer_id, recipientId: p.recipient_id, paymentIds: [p.id],
    facts: [
      { kind: "registry", recipientId: p.recipient_id, foundedOn: record.foundedOn, activityCode: record.activityCode, activity: record.activity, sourceUrl: record.sourceUrl },
      { kind: "payment_amount", paymentId: p.id, amount: p.amount },
    ],
    key: `UNUSUAL_RECIPIENT|${p.id}`,
  }
}

/**
 * CONCENTRATION ("captive supplier"): share of a payer's purchases in a
 * category group that went to one recipient. This is the fast screening count:
 * it counts every award/payment, including ones later cancelled. The Verifier
 * applies the strict rule (completed only) before anything reaches a dossier.
 */
export function concentrationSignal(payerId: string, recipientId: string, group: string, from: string, to: string): SignalDraft | null {
  if (REFERENCE.categories[group]?.naturalMonopoly) return null
  const list = paymentsByPayer(payerId, { group, from, to })
  if (list.length < CONCENTRATION_MIN_COUNT) return null
  const mine = list.filter((x) => x.recipient_id === recipientId)
  const share = mine.length / list.length
  if (share < CONCENTRATION_SHARE || mine.length < 3) return null
  const recipientName = mine[0].recipient_name
  const payerName = mine[0].payer_name
  const isProcurement = mine[0].source === "procurement"
  const noun = isProcurement ? "procurements" : "payments"
  return {
    code: "CONCENTRATION", agent: "network",
    strength: round(0.4 + 0.3 * Math.min(1, (share - CONCENTRATION_SHARE) / (1 - CONCENTRATION_SHARE)), 2),
    summary: `${recipientName} won ${mine.length} of ${list.length} ${group === "it_equipment" ? "IT equipment" : group.replace("_", " ")} ${noun} of ${payerName} between ${list[0].date} and ${list[list.length - 1].date} (${round(share * 100)}%).`,
    rule: `one recipient holds >= ${CONCENTRATION_SHARE * 100}% of >= ${CONCENTRATION_MIN_COUNT} ${noun} of a payer in a category group`,
    payerId, recipientId, paymentIds: mine.map((x) => x.id),
    facts: [{ kind: "supplier_share", payerId, recipientId, group, wins: mine.length, total: list.length, from: list[0].date, to: list[list.length - 1].date }],
    key: `CONCENTRATION|${payerId}|${recipientId}|${group}`,
  }
}

export interface RecipientProfile {
  recipientId: string
  recipientName: string
  payers: number
  payments: number
  total: number
  byPayerGroup: Array<{ payerId: string; payerName: string; group: string; count: number }>
}

/** Branch investigation of a recipient: where does its public money come from? */
export function investigateRecipientNetwork(recipientId: string, from: string, to: string): { profile: RecipientProfile; signals: SignalDraft[] } {
  const payments = paymentsByRecipient(recipientId, { from, to })
  const pairs = new Map<string, { payerId: string; payerName: string; group: string; count: number }>()
  for (const p of payments) {
    const group = categoryGroup(p.category)
    const key = `${p.payer_id}|${group}`
    const e = pairs.get(key) ?? { payerId: p.payer_id, payerName: p.payer_name, group, count: 0 }
    e.count++
    pairs.set(key, e)
  }
  const signals: SignalDraft[] = []
  for (const e of pairs.values()) {
    if (e.count < 3) continue
    const s = concentrationSignal(e.payerId, recipientId, e.group, from, to)
    if (s) signals.push(s)
  }
  return {
    profile: {
      recipientId,
      recipientName: payments[0]?.recipient_name ?? recipientId,
      payers: new Set(payments.map((p) => p.payer_id)).size,
      payments: payments.length,
      total: payments.reduce((s, p) => s + p.amount, 0),
      byPayerGroup: [...pairs.values()].sort((a, b) => b.count - a.count),
    },
    signals,
  }
}
