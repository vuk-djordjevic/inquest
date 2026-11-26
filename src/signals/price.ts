/** Price signal formulas (deterministic). The Price agent decides when to run them. */
import { REFERENCE } from "../config.js"
import { peerUnitPrices } from "../db/source.js"
import type { Payment, PriceReference, ProcurementContext, SignalDraft } from "../domain/types.js"
import { clamp, formatRsd, median, round, tukeyFences } from "./stats.js"

export const MIN_PEERS = 8

const KIND_PLURAL: Record<string, string> = {
  school: "schools", health_center: "health centers", utility: "utility companies",
  local_community: "local communities", municipality: "municipalities", ministry: "ministries",
}
export const MIN_MARKET_COMPARABLES = 3
export const MARKET_RATIO_THRESHOLD = 2

export function unitPrice(p: Payment): number | null {
  if (!p.quantity || p.quantity <= 0) return null
  return p.amount / p.quantity
}

/**
 * PEER_PRICE (OCP R016 for procurement): unit price above Q3 + 1.5 x IQR of
 * the same category among institutions of the same kind, and at least 1.5x
 * the median so that tiny absolute differences don't count.
 */
export function peerPriceSignal(p: Payment): SignalDraft | null {
  const spec = REFERENCE.categories[p.category]
  const price = unitPrice(p)
  if (!spec?.comparable || price === null || p.status !== "completed") return null
  const peers = peerUnitPrices(p.category, p.payer_kind).filter((r) => r.id !== p.id).map((r) => r.unit_price)
  if (peers.length < MIN_PEERS) return null
  const f = tukeyFences(peers)
  const ratio = price / f.median
  if (price <= f.upper || ratio < 1.5) return null
  return {
    code: "PEER_PRICE",
    agent: "price",
    strength: clamp(0.35 + 0.2 * (ratio - 1), 0, 0.9),
    summary: `Unit price ${formatRsd(price)} per ${spec.unit} is ${round(ratio, 1)}x the median of ${f.n} comparable purchases by other ${KIND_PLURAL[p.payer_kind] ?? "institutions"} (${formatRsd(f.median)}).`,
    rule: `unit price > Q3 + 1.5 x IQR (= ${formatRsd(f.upper)}) for "${p.category}" among ${f.n} purchases of the same institution kind`,
    payerId: p.payer_id,
    recipientId: p.recipient_id,
    paymentIds: [p.id],
    facts: [
      { kind: "unit_price", paymentId: p.id, unitPrice: round(price, 2), unit: spec.unit },
      { kind: "peer_median", category: p.category, payerKind: p.payer_kind, unit: spec.unit, median: round(f.median, 2), peers: f.n },
    ],
    key: `PEER_PRICE|${p.id}`,
  }
}

/** WIDE_BID_SPREAD (OCP R022): (highest - lowest) / mean of the bids is unusually large. */
export const BID_SPREAD_THRESHOLD = 0.6
export function bidSpreadSignal(p: Payment, ctx: ProcurementContext | undefined): SignalDraft | null {
  const amounts = (ctx?.bids ?? []).map((b) => b.amount).filter((a): a is number => typeof a === "number")
  if (amounts.length < 3) return null
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length
  const spread = (Math.max(...amounts) - Math.min(...amounts)) / mean
  if (spread < BID_SPREAD_THRESHOLD) return null
  return {
    code: "WIDE_BID_SPREAD",
    agent: "price",
    strength: spread >= 0.9 ? 0.65 : 0.55,
    summary: `Bids range from ${formatRsd(Math.min(...amounts))} to ${formatRsd(Math.max(...amounts))}; the spread is ${round(spread * 100)}% of the mean bid.`,
    rule: `(highest - lowest) / mean of ${amounts.length} bids >= ${BID_SPREAD_THRESHOLD * 100}%`,
    payerId: p.payer_id,
    recipientId: p.recipient_id,
    paymentIds: [p.id],
    facts: [{ kind: "bid_spread", paymentId: p.id, spreadPct: round(spread * 100, 1) }],
    key: `WIDE_BID_SPREAD|${p.id}`,
  }
}

export type MarketDecision =
  | { outcome: "insufficient_data"; comparables: number; note: string }
  | { outcome: "within_range"; comparables: number; median: number; ratio: number; note: string }
  | { outcome: "signal"; comparables: number; median: number; ratio: number; signal: SignalDraft }

/**
 * MARKET_PRICE: the rule (not the LLM) decides. Needs at least 3 verified
 * comparable offers; a price above twice their median is a signal.
 */
export function marketDecision(p: Payment, refs: PriceReference[]): MarketDecision {
  const spec = REFERENCE.categories[p.category]
  const price = unitPrice(p)
  const verified = refs.filter((r) => r.verified && r.normalizedRsd > 0)
  if (price === null || verified.length < MIN_MARKET_COMPARABLES) {
    return {
      outcome: "insufficient_data",
      comparables: verified.length,
      note: `Not enough data for a market comparison (${verified.length} verified comparable offers, at least ${MIN_MARKET_COMPARABLES} needed).`,
    }
  }
  const m = median(verified.map((r) => r.normalizedRsd))
  const ratio = price / m
  if (ratio <= MARKET_RATIO_THRESHOLD) {
    return {
      outcome: "within_range",
      comparables: verified.length,
      median: m,
      ratio,
      note: `Unit price is ${round(ratio, 1)}x the median of ${verified.length} market offers; within the accepted range.`,
    }
  }
  return {
    outcome: "signal",
    comparables: verified.length,
    median: m,
    ratio,
    signal: {
      code: "MARKET_PRICE",
      agent: "price",
      strength: clamp(0.4 + 0.1 * ratio, 0, 0.9),
      summary: `Unit price ${formatRsd(price)} per ${spec.unit} is ${round(ratio, 1)}x the median of ${verified.length} comparable market offers (${formatRsd(m)}).`,
      rule: `unit price > ${MARKET_RATIO_THRESHOLD} x median of >= ${MIN_MARKET_COMPARABLES} verified market offers`,
      payerId: p.payer_id,
      recipientId: p.recipient_id,
      paymentIds: [p.id],
      facts: [
        { kind: "unit_price", paymentId: p.id, unitPrice: round(price, 2), unit: spec.unit },
        { kind: "market_median", paymentId: p.id, median: round(m, 2), comparables: verified.length, unit: spec.unit },
        ...verified.map((r) => ({ kind: "price_ref" as const, url: r.url, price: r.price, currency: r.currency, quote: r.quote })),
      ],
      key: `MARKET_PRICE|${p.id}`,
    },
  }
}
