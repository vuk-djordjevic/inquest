/** Procurement-procedure signal formulas (OCP red flags, simplified). */
import { REFERENCE } from "../config.js"
import type { Payment, ProcurementContext, SignalDraft } from "../domain/types.js"
import { daysBetween, formatRsd, round } from "./stats.js"

export const CLOSE_BID_THRESHOLD = 0.001 // 0.1 %
export const AMENDMENT_RATIO_THRESHOLD = 1.3

function base(p: Payment) {
  return { payerId: p.payer_id, recipientId: p.recipient_id, paymentIds: [p.id] }
}

function bidAmounts(ctx: ProcurementContext): number[] {
  return ctx.bids.map((b) => b.amount).filter((a): a is number => typeof a === "number")
}

/** R018: an open procedure that received a single bid. */
export function singleBidSignal(p: Payment, ctx: ProcurementContext): SignalDraft | null {
  const bids = ctx.bids_count ?? ctx.bids.length
  if (ctx.procedure_type !== "open" || bids !== 1) return null
  return {
    code: "SINGLE_BID", agent: "procedure", strength: 0.3,
    summary: "The open procedure received only one bid.",
    rule: "open procedure and number of bidders = 1",
    ...base(p),
    facts: [{ kind: "bids_count", paymentId: p.id, bids: 1 }],
    key: `SINGLE_BID|${p.id}`,
  }
}

/** R003: bid deadline - tender start below the minimum for the procedure type. */
export function shortTenderSignal(p: Payment, ctx: ProcurementContext): SignalDraft | null {
  const table = p.dataset === "real" && REFERENCE.minimumTenderDaysReal ? REFERENCE.minimumTenderDaysReal : REFERENCE.minimumTenderDays
  const minimum = ctx.procedure_type ? table[ctx.procedure_type] : undefined
  if (!minimum || !ctx.tender_start || !ctx.tender_end) return null
  const days = daysBetween(ctx.tender_start, ctx.tender_end)
  if (days >= minimum) return null
  return {
    code: "SHORT_TENDER", agent: "procedure", strength: days <= minimum / 3 ? 0.45 : 0.3,
    summary: `Bidders had ${days} days to submit bids; the minimum for this procedure type is ${minimum} days.`,
    rule: `tender end - tender start < ${minimum} days (${ctx.procedure_type})`,
    ...base(p),
    facts: [{ kind: "tender_days", paymentId: p.id, days, minimum }],
    key: `SHORT_TENDER|${p.id}`,
  }
}

/** R028: two bids in the same procedure with exactly the same price. */
export function identicalBidsSignal(p: Payment, ctx: ProcurementContext): SignalDraft | null {
  const amounts = bidAmounts(ctx)
  const counts = new Map<number, number>()
  for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1)
  const dup = [...counts.entries()].find(([, c]) => c >= 2)
  if (!dup) return null
  return {
    code: "IDENTICAL_BIDS", agent: "procedure", strength: 0.6,
    summary: `${dup[1]} bids in the same procedure have exactly the same price (${formatRsd(dup[0])}).`,
    rule: "two or more bids in one procedure with identical price",
    ...base(p),
    facts: [{ kind: "identical_bids", paymentId: p.id, amount: dup[0], count: dup[1] }],
    key: `IDENTICAL_BIDS|${p.id}`,
  }
}

/** R024: second-lowest bid suspiciously close to the winning bid. */
export function closeSecondBidSignal(p: Payment, ctx: ProcurementContext): SignalDraft | null {
  const amounts = [...new Set(bidAmounts(ctx))].sort((a, b) => a - b)
  if (amounts.length < 2) return null
  const gap = (amounts[1] - amounts[0]) / amounts[0]
  if (gap > CLOSE_BID_THRESHOLD) return null
  return {
    code: "CLOSE_SECOND_BID", agent: "procedure", strength: gap <= CLOSE_BID_THRESHOLD / 2 ? 0.55 : 0.4,
    summary: `The second-lowest bid is only ${round(gap * 100, 2)}% above the winning bid.`,
    rule: `(second lowest - winning) / winning <= ${CLOSE_BID_THRESHOLD * 100}%`,
    ...base(p),
    facts: [{ kind: "bid_gap", paymentId: p.id, gapPct: round(gap * 100, 3) }],
    key: `CLOSE_SECOND_BID|${p.id}`,
  }
}

/** Contract value raised by amendments above the threshold ratio. */
export function amendmentSignal(p: Payment, ctx: ProcurementContext): SignalDraft | null {
  if (!ctx.original_value || !ctx.final_value || !ctx.amendments.length) return null
  const ratio = ctx.final_value / ctx.original_value
  if (ratio < AMENDMENT_RATIO_THRESHOLD) return null
  return {
    code: "AMENDMENT_INFLATION", agent: "procedure", strength: ratio >= 1.5 ? 0.6 : 0.45,
    summary: `The contract was signed for ${formatRsd(ctx.original_value)} and is worth ${formatRsd(ctx.final_value)} after ${ctx.amendments.length} amendment(s) (+${round((ratio - 1) * 100)}%).`,
    rule: `value after amendments / original value >= ${AMENDMENT_RATIO_THRESHOLD}`,
    ...base(p),
    facts: [{ kind: "amendment", paymentId: p.id, originalValue: ctx.original_value, finalValue: ctx.final_value }],
    key: `AMENDMENT_INFLATION|${p.id}`,
  }
}

export const PROCEDURE_CHECKS = [singleBidSignal, shortTenderSignal, identicalBidsSignal, closeSecondBidSignal, amendmentSignal]
