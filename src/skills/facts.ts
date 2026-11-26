/** Human-readable rendering of facts. Prose about numbers is generated from facts, so corrected facts change the text. */
import { REFERENCE } from "../config.js"
import { getPayment } from "../db/source.js"
import type { Fact } from "../domain/types.js"
import { formatRsd, round } from "../signals/stats.js"

export const groupLabel = (group: string) => (group === "it_equipment" ? "IT equipment" : label(group))
const label = (category: string) => REFERENCE.categories[category]?.label.toLowerCase() ?? category.replace("_", " ")
const payment = (id: string) => {
  const p = getPayment(id)
  return p ? `${p.payer_name} → ${p.recipient_name}, ${p.date}` : id
}

export function factSentence(f: Fact): string {
  switch (f.kind) {
    case "payment_amount":
      return `Payment ${f.paymentId} (${payment(f.paymentId)}) amounts to ${formatRsd(f.amount)}.`
    case "unit_price":
      return `Unit price of payment ${f.paymentId} is ${formatRsd(f.unitPrice)} per ${f.unit}.`
    case "peer_median":
      return `Median unit price for ${label(f.category)} among ${f.peers} purchases by institutions of the same kind (${f.payerKind.replace("_", " ")}) is ${formatRsd(f.median)} per ${f.unit}.`
    case "payments_in_window":
      return f.recipientId && f.count !== f.paymentIds.length
        ? `${f.paymentIds.length} payments in the window, ${formatRsd(f.total)} in total; ${f.count} of them went to the same recipient.`
        : `${f.count} payments${f.recipientId ? " to the same recipient" : ""} in the window, ${formatRsd(f.total)} in total.`
    case "supplier_share":
      return `The recipient won ${f.wins} of ${f.total} ${groupLabel(f.group)} purchases of the payer between ${f.from} and ${f.to}.`
    case "bids_count":
      return `The procedure received ${f.bids} bid${f.bids === 1 ? "" : "s"}.`
    case "tender_days":
      return `Bidders had ${f.days} days to submit bids (minimum for the procedure type: ${f.minimum}).`
    case "identical_bids":
      return `${f.count} bids had exactly the same price, ${formatRsd(f.amount)}.`
    case "bid_gap":
      return `The second-lowest bid was ${f.gapPct}% above the winning bid.`
    case "bid_spread":
      return `The spread between the highest and lowest bid was ${f.spreadPct}% of the mean bid.`
    case "amendment":
      return `Contract value went from ${formatRsd(f.originalValue)} to ${formatRsd(f.finalValue)} through amendments.`
    case "plan_vs_spent":
      return `${f.year} plan for ${label(f.category)}: ${formatRsd(f.planned)}; paid: ${formatRsd(f.spent)}.`
    case "december_share":
      return `${f.sharePct}% of the ${f.year} spending on ${label(f.category)} was paid in December.`
    case "object_repeats":
      return `"${f.objectRef}" was paid for ${f.count} times for ${label(f.category)}, ${formatRsd(f.total)} in total.`
    case "identical_amounts":
      return `${f.count} payments of exactly ${formatRsd(f.amount)} to the same recipient.`
    case "noncompetitive_share":
      return `${f.noncompetitive} of ${f.total} procedures above the threshold were negotiated without a public call.`
    case "registry":
      return `Business register: registered ${f.foundedOn ?? "unknown"}, activity ${f.activityCode ?? "?"} ${f.activity ?? ""} (${f.sourceUrl}).`
    case "first_payment_after_founding":
      return `First payment arrived ${f.days} days after the company was registered.`
    case "market_median":
      return `Median of ${f.comparables} verified market offers is ${formatRsd(f.median)} per ${f.unit}.`
    case "price_ref":
      return `Market offer: ${f.price} ${f.currency} — "${f.quote}" (${f.url}).`
    case "description":
      return `Payment ${f.paymentId} description: "${f.text}".`
  }
}

/** Numbers a dossier may state as "N of M" pairs, collected from facts. */
export function allowedRatios(facts: Fact[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const f of facts) {
    if (f.kind === "supplier_share") out.push([f.wins, f.total])
    if (f.kind === "noncompetitive_share") out.push([f.noncompetitive, f.total])
  }
  return out
}

export function factKey(f: Fact): string {
  return JSON.stringify(f)
}

export function ratioText(a: number, b: number): string {
  return `${a} of ${b} (${round((a / b) * 100)}%)`
}
