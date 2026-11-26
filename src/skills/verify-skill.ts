/**
 * Verifier agent skill. Recomputes every fact from the source records with
 * strict rules (for example: only completed contracts count), checks that each
 * market price really appears on its page, and checks the dossier's prose for
 * unbacked numbers and forbidden wording. Anything wrong goes back to the
 * Dossier writer with a correction.
 */
import type { CaseBoard } from "../db/board.js"
import { getBudgetPlan, getPayment, getProcurementContext, paymentsByPayer, paymentsByRecipient, peerUnitPrices, procedureTypesByPayer } from "../db/source.js"
import { BANNED_WORDS } from "../domain/signal-catalog.js"
import type { Fact, PriceReference } from "../domain/types.js"
import { LANGUAGE_RULES, arr, bool, obj, str, think } from "../llm/think.js"
import type { Rejection } from "../runtime/events.js"
import { median, daysBetween, round } from "../signals/stats.js"
import { pageContains } from "../tools/web.js"
import { lookupRecipient } from "./network-skill.js"
import { allowedRatios } from "./facts.js"

export interface FactCheck {
  ok: boolean
  note: string
  corrected?: Fact
}

const close = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * tol)

export async function verifyFact(f: Fact, board: CaseBoard): Promise<FactCheck> {
  switch (f.kind) {
    case "payment_amount": {
      const p = getPayment(f.paymentId)
      if (!p) return { ok: false, note: `payment ${f.paymentId} not found in source records` }
      return close(p.amount, f.amount) ? { ok: true, note: "matches source record" } : { ok: false, note: `source amount is ${p.amount}`, corrected: { ...f, amount: p.amount } }
    }
    case "unit_price": {
      const p = getPayment(f.paymentId)
      if (!p?.quantity) return { ok: false, note: "no quantity in source record" }
      const u = round(p.amount / p.quantity, 2)
      return close(u, f.unitPrice) ? { ok: true, note: "recomputed from amount / quantity" } : { ok: false, note: `recomputed unit price is ${u}`, corrected: { ...f, unitPrice: u } }
    }
    case "peer_median": {
      const values = peerUnitPrices(f.category, f.payerKind).map((r) => r.unit_price)
      const m = round(median(values), 2)
      // The Price agent excludes the payment itself; allow 5% for that.
      return close(m, f.median, 0.05) ? { ok: true, note: `median of ${values.length} purchases recomputed` } : { ok: false, note: `recomputed median is ${m}`, corrected: { ...f, median: m } }
    }
    case "payments_in_window": {
      const ps = f.paymentIds.map(getPayment)
      if (ps.some((p) => !p)) return { ok: false, note: "a referenced payment does not exist" }
      const done = ps.filter((p) => p!.status === "completed")
      const counted = f.recipientId ? done.filter((p) => p!.recipient_id === f.recipientId) : done
      const total = done.reduce((s, p) => s + p!.amount, 0)
      if (counted.length === f.count && close(total, f.total)) return { ok: true, note: "count and total recomputed" }
      return { ok: false, note: `recomputed: ${counted.length} payments, total ${total}`, corrected: { ...f, count: counted.length, total } }
    }
    case "supplier_share": {
      // Strict rule: only completed contracts count; cancelled awards are excluded.
      const list = paymentsByPayer(f.payerId, { group: f.group, from: f.from, to: f.to }).filter((p) => p.status === "completed")
      const wins = list.filter((p) => p.recipient_id === f.recipientId).length
      if (wins === f.wins && list.length === f.total) return { ok: true, note: "recomputed over completed contracts" }
      const cancelled = paymentsByPayer(f.payerId, { group: f.group, from: f.from, to: f.to }).filter((p) => p.status === "cancelled").length
      return {
        ok: false,
        note: `${f.wins} of ${f.total} counts ${cancelled} cancelled award(s); over completed contracts it is ${wins} of ${list.length}`,
        corrected: { ...f, wins, total: list.length },
      }
    }
    case "bids_count": {
      const ctx = getProcurementContext(f.paymentId)
      const n = ctx?.bids_count ?? ctx?.bids.length
      return n === f.bids ? { ok: true, note: "matches procurement record" } : { ok: false, note: `procurement record shows ${n} bids`, corrected: n !== undefined ? { ...f, bids: n } : undefined }
    }
    case "tender_days": {
      const ctx = getProcurementContext(f.paymentId)
      if (!ctx?.tender_start || !ctx.tender_end) return { ok: false, note: "tender period missing in source" }
      const d = daysBetween(ctx.tender_start, ctx.tender_end)
      return d === f.days ? { ok: true, note: "recomputed from tender period" } : { ok: false, note: `tender period is ${d} days`, corrected: { ...f, days: d } }
    }
    case "identical_bids": {
      const ctx = getProcurementContext(f.paymentId)
      const n = (ctx?.bids ?? []).filter((b) => b.amount === f.amount).length
      return n === f.count ? { ok: true, note: "matches bids" } : { ok: false, note: `${n} bids with that price`, corrected: { ...f, count: n } }
    }
    case "bid_gap": {
      const amounts = [...new Set((getProcurementContext(f.paymentId)?.bids ?? []).map((b) => b.amount ?? NaN))].filter(Number.isFinite).sort((a, b) => a - b)
      if (amounts.length < 2) return { ok: false, note: "fewer than two bids in source" }
      const gap = round(((amounts[1] - amounts[0]) / amounts[0]) * 100, 3)
      return close(gap, f.gapPct, 0.02) ? { ok: true, note: "recomputed from bids" } : { ok: false, note: `gap is ${gap}%`, corrected: { ...f, gapPct: gap } }
    }
    case "bid_spread": {
      const amounts = (getProcurementContext(f.paymentId)?.bids ?? []).map((b) => b.amount ?? NaN).filter(Number.isFinite)
      if (amounts.length < 2) return { ok: false, note: "not enough bids in source" }
      const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length
      const s = round(((Math.max(...amounts) - Math.min(...amounts)) / mean) * 100, 1)
      return close(s, f.spreadPct, 0.02) ? { ok: true, note: "recomputed from bids" } : { ok: false, note: `spread is ${s}%`, corrected: { ...f, spreadPct: s } }
    }
    case "amendment": {
      const ctx = getProcurementContext(f.paymentId)
      if (!ctx?.original_value || !ctx.final_value) return { ok: false, note: "values missing in source" }
      return close(ctx.original_value, f.originalValue) && close(ctx.final_value, f.finalValue)
        ? { ok: true, note: "matches award and contract values" }
        : { ok: false, note: "values differ from source", corrected: { ...f, originalValue: ctx.original_value, finalValue: ctx.final_value } }
    }
    case "plan_vs_spent": {
      const planned = getBudgetPlan(f.payerId, f.category, f.year)
      const spent = paymentsByPayer(f.payerId, { category: f.category, from: `${f.year}-01-01`, to: `${f.year}-12-31` })
        .filter((p) => p.status === "completed").reduce((s, p) => s + p.amount, 0)
      if (planned === undefined) return { ok: false, note: "no budget plan in source" }
      return close(planned, f.planned) && close(spent, f.spent) ? { ok: true, note: "plan and payments recomputed" } : { ok: false, note: "differs from source", corrected: { ...f, planned, spent } }
    }
    case "december_share": {
      const ps = paymentsByPayer(f.payerId, { category: f.category, from: `${f.year}-01-01`, to: `${f.year}-12-31` }).filter((p) => p.status === "completed")
      const total = ps.reduce((s, p) => s + p.amount, 0)
      const dec = ps.filter((p) => p.date.slice(5, 7) === "12").reduce((s, p) => s + p.amount, 0)
      const share = round((dec / total) * 100, 1)
      return close(share, f.sharePct, 0.01) ? { ok: true, note: "recomputed" } : { ok: false, note: `December share is ${share}%`, corrected: { ...f, sharePct: share } }
    }
    case "object_repeats": {
      const ps = paymentsByPayer(f.payerId, { category: f.category }).filter((p) => p.status === "completed" && p.object_ref === f.objectRef)
      const total = ps.reduce((s, p) => s + p.amount, 0)
      return ps.length === f.count && close(total, f.total) ? { ok: true, note: "recomputed" } : { ok: false, note: `${ps.length} payments, total ${total}`, corrected: { ...f, count: ps.length, total } }
    }
    case "identical_amounts": {
      const n = paymentsByPayer(f.payerId).filter((p) => p.status === "completed" && p.recipient_id === f.recipientId && p.amount === f.amount).length
      return n === f.count ? { ok: true, note: "recomputed" } : { ok: false, note: `${n} payments`, corrected: { ...f, count: n } }
    }
    case "noncompetitive_share": {
      const procs = procedureTypesByPayer(f.payerId).filter((r) => r.procedure_type && r.procedure_type !== "direct" && r.status === "completed")
      const limited = procs.filter((r) => r.procedure_type === "limited").length
      return limited === f.noncompetitive && procs.length === f.total
        ? { ok: true, note: "recomputed" }
        : { ok: false, note: `${limited} of ${procs.length}`, corrected: { ...f, noncompetitive: limited, total: procs.length } }
    }
    case "registry": {
      const rec = await lookupRecipient(f.recipientId)
      if (!rec) return { ok: false, note: "company not found in the register" }
      return rec.foundedOn === f.foundedOn && rec.activityCode === f.activityCode
        ? { ok: true, note: `matches ${rec.sourceUrl}` }
        : { ok: false, note: "register record differs", corrected: { ...f, foundedOn: rec.foundedOn, activityCode: rec.activityCode, activity: rec.activity } }
    }
    case "first_payment_after_founding": {
      const rec = await lookupRecipient(f.recipientId)
      const first = paymentsByRecipient(f.recipientId).filter((p) => p.status === "completed")[0]
      if (!rec?.foundedOn || !first) return { ok: false, note: "cannot recompute" }
      const d = daysBetween(rec.foundedOn, first.date)
      return d === f.days ? { ok: true, note: "recomputed from register and payments" } : { ok: false, note: `${d} days`, corrected: { ...f, days: d } }
    }
    case "market_median": {
      const refs = board.priceRefs([f.paymentId]).filter((r) => r.verified)
      if (refs.length < 3) return { ok: false, note: `only ${refs.length} verified offers on record` }
      const m = round(median(refs.map((r) => r.normalizedRsd)), 2)
      return close(m, f.median, 0.01) && refs.length === f.comparables ? { ok: true, note: "recomputed from verified offers" } : { ok: false, note: `median ${m} of ${refs.length}`, corrected: { ...f, median: m, comparables: refs.length } }
    }
    case "price_ref":
      return checkPriceOnPage(f.url, f.price, f.quote)
    case "description": {
      const p = getPayment(f.paymentId)
      return p && (p.description ?? "") === f.text ? { ok: true, note: "matches source record" } : { ok: false, note: "description differs", corrected: p ? { ...f, text: p.description ?? "" } : undefined }
    }
  }
}

function digitsOf(n: number): string[] {
  const whole = String(Math.round(n))
  // Common ways the same number is printed on a page: 18000, 18.000, 18,000, 18 000
  return [whole, whole.replace(/\B(?=(\d{3})+(?!\d))/g, "."), whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","), whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")]
}

export function checkPriceOnPage(url: string, price: number, quote: string): FactCheck {
  if (!pageContains(url, quote)) return { ok: false, note: "quoted text not found on the page" }
  const q = quote.replace(/\s+/g, " ")
  if (!digitsOf(price).some((d) => q.includes(d))) return { ok: false, note: `price ${price} does not appear in the quoted text` }
  return { ok: true, note: "price found on the page" }
}

export function verifyPriceRefs(refs: PriceReference[]): PriceReference[] {
  return refs.map((r) => {
    const c = checkPriceOnPage(r.url, r.price, r.quote)
    return { ...r, verified: c.ok, verifyNote: c.note }
  })
}

export interface DossierVerification {
  approved: boolean
  rejections: Rejection[]
  checks: Array<{ factIndex: number; ok: boolean; note: string }>
}

export async function verifyDossier(board: CaseBoard, caseId: number, bodyMd: string, facts: Fact[]): Promise<DossierVerification> {
  const rejections: Rejection[] = []
  const checks: DossierVerification["checks"] = []
  const results = await Promise.all(facts.map((f) => verifyFact(f, board)))
  results.forEach((r, i) => {
    checks.push({ factIndex: i, ok: r.ok, note: r.note })
    if (!r.ok) rejections.push({ factIndex: i, reason: `F${i + 1}: ${r.note}`, corrected: r.corrected })
  })

  // Wording: risk vocabulary only.
  const lower = bodyMd.toLowerCase()
  for (const w of BANNED_WORDS) if (lower.includes(w)) rejections.push({ factIndex: null, reason: `forbidden wording "${w}" - describe risk signals, not guilt` })

  // Every "N of M" in the prose must be backed by a fact that passed verification.
  const verifiedRatios = allowedRatios(facts.filter((_, i) => results[i].ok))
  for (const m of bodyMd.matchAll(/\b(\d+)\s+(?:of|od)\s+(\d+)\b/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (!verifiedRatios.some(([x, y]) => x === a && y === b)) {
      const failed = allowedRatios(facts).some(([x, y]) => x === a && y === b)
      if (!failed) rejections.push({ factIndex: null, reason: `"${m[0]}" is not backed by any fact` })
    }
  }

  // The LLM reads the prose against the verified facts (skipped offline).
  const llm = await think<{ consistent: boolean; problems: string[] }>({
    role: "verifier",
    task: "check_prose",
    model: "smart",
    caseId,
    instruction: `You are the Verifier. Check a dossier draft against its fact list. Report a problem for any statement that contradicts a fact, states a number not in the facts, or claims more than the facts show (e.g. implies guilt). Do not report style issues. ${LANGUAGE_RULES}`,
    prompt: JSON.stringify({ dossier: bodyMd.split("## Source records")[0], facts: facts.map((f, i) => ({ id: `F${i + 1}`, fact: f, verified: results[i].ok })) }),
    schema: obj({ consistent: bool(), problems: arr(str()) }),
    offline: () => ({ consistent: true, problems: [] }),
  })
  if (!llm.value.consistent) for (const p of llm.value.problems.slice(0, 5)) rejections.push({ factIndex: null, reason: p })

  return { approved: rejections.length === 0, rejections, checks }
}
