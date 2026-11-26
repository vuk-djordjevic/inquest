/**
 * Price agent skill.
 *
 * 1. Understanding the payment (LLM): what exactly was bought, in which unit.
 * 2. Finding comparables: other institutions in the data (code) and, for
 *    categories where it makes sense, market offers on the internet - several
 *    searches in parallel, the LLM reads each page and normalizes the price.
 * 3. Verification: the Verifier checks every extracted price against its page.
 * 4. Decision: a rule (median, ratios), never the LLM.
 * 5. Justification (LLM): look for a legitimate reason before raising a signal.
 * 6. Confidence: fewer than 3 comparables -> "not enough data", no signal.
 */
import { CONFIG, REFERENCE } from "../config.js"
import { getProcurementContext, peerUnitPrices } from "../db/source.js"
import type { Payment, PriceReference, SignalDraft } from "../domain/types.js"
import { LANGUAGE_RULES, arr, bool, nullable, num, obj, str, think } from "../llm/think.js"
import { MIN_PEERS, bidSpreadSignal, marketDecision, peerPriceSignal, unitPrice } from "../signals/price.js"
import { formatRsd } from "../signals/stats.js"
import { TOOLS } from "../tools/tools.js"
import { memo, webAvailable } from "../tools/web.js"
import { EXPLANATION_HINTS, findExplanation } from "./explanations.js"
import type { Reporter } from "./reporter.js"

export interface PriceScreenResult {
  signals: SignalDraft[]
  refs: PriceReference[]
}

/** Market research is expensive (searches, page reads, LLM calls); cap it per run. */
let marketResearchBudget = 0
export function resetPriceBudget(n = 25): void {
  marketResearchBudget = n
}

export async function screenPrice(p: Payment, reporter: Reporter): Promise<PriceScreenResult> {
  const signals: SignalDraft[] = []
  let refs: PriceReference[] = []

  const peer = peerPriceSignal(p)
  if (peer) signals.push(await justify(p, peer))

  const ctx = p.source === "procurement" ? getProcurementContext(p.id) : undefined
  const spread = bidSpreadSignal(p, ctx)
  if (spread) signals.push(spread)

  const spec = REFERENCE.categories[p.category]
  const fewPeers = peerUnitPrices(p.category, p.payer_kind).length - 1 < MIN_PEERS
  const worthMarketCheck = spec?.marketSearch && unitPrice(p) !== null && p.status === "completed" && (peer !== null || (fewPeers && p.amount >= 100_000))
  if (worthMarketCheck && webAvailable() && marketResearchBudget > 0) {
    marketResearchBudget--
    const market = await marketResearch(p, reporter)
    refs = market.refs
    if (market.signal) signals.push(await justify(p, market.signal))
  }
  return { signals, refs }
}

interface Understanding {
  item: string
  unit: string
  quantityInUnit: number | null
  unknowns: string[]
  comparable: boolean
  queries: string[]
}

interface Extraction {
  found: boolean
  price: number | null
  currency: string | null
  priceUnit: string | null
  normalizedPerUnitRsd: number | null
  includes: string
  quote: string
}

async function understand(p: Payment): Promise<Understanding> {
  const spec = REFERENCE.categories[p.category]
  return memo(`understand:${p.id}:${p.description}`, async () => {
    const r = await think<Understanding>({
      role: "price",
      task: "understand_payment",
      instruction: `You are the Price agent of a public-spending risk screening team. You read one payment record and describe exactly what was bought, so that comparable market offers can be found. Record anything that is not stated (for example whether transport is included) as unknown; never guess. Then write 3-4 web search queries, in the language of the description (Serbian), that would find current public offers or price lists for the same thing in the same unit.`,
      prompt: JSON.stringify({
        description: p.description,
        category: spec.label,
        comparisonUnit: spec.unit,
        quantity: p.quantity,
        amountRsd: p.amount,
        unitPriceRsd: unitPrice(p),
        date: p.date,
      }),
      schema: obj({
        item: str("what was bought, specific"),
        unit: str("the comparison unit, e.g. 'per student per day', 'per m2', 'per piece'"),
        quantityInUnit: nullable(num()),
        unknowns: arr(str()),
        comparable: bool("can market offers meaningfully be compared to this?"),
        queries: arr(str(), "3-4 search queries"),
      }),
      offline: () => ({
        item: p.description ?? spec.label,
        unit: spec.unit,
        quantityInUnit: p.quantity,
        unknowns: [],
        comparable: true,
        queries: [`${p.description ?? spec.label} cena`, `${spec.label} cena po ${spec.unit}`],
      }),
    })
    return { value: r.value, cacheable: r.via === "llm" }
  })
}

async function extract(p: Payment, u: Understanding, url: string, title: string, text: string): Promise<Extraction> {
  return memo(`extract:${p.id}:${url}`, async () => {
    const r = await think<Extraction>({
      role: "price",
      task: "extract_price",
      instruction: `You read one web page and extract a price offer comparable to a public purchase. Only use what the page says. "quote" must be copied character-for-character from the page text and must contain the price. Convert the price to RSD per comparison unit (1 EUR = ${REFERENCE.eurToRsd} RSD), dividing by days/persons/quantity as needed. If the page has no comparable offer, return found=false.`,
      prompt: JSON.stringify({
        purchase: { item: u.item, unit: u.unit, unknowns: u.unknowns, description: p.description },
        page: { url, title, text: text.slice(0, 12_000) },
      }),
      schema: obj({
        found: bool(),
        price: nullable(num("price as written on the page")),
        currency: nullable(str()),
        priceUnit: nullable(str("what the page price covers, e.g. 'per person, 2 days, half board'")),
        normalizedPerUnitRsd: nullable(num("price in RSD per comparison unit")),
        includes: str("what the offer includes or excludes"),
        quote: str("exact text from the page containing the price"),
      }),
      offline: () => ({ found: false, price: null, currency: null, priceUnit: null, normalizedPerUnitRsd: null, includes: "", quote: "" }),
    })
    return { value: r.value, cacheable: r.via === "llm" }
  })
}

async function marketResearch(p: Payment, reporter: Reporter): Promise<{ refs: PriceReference[]; signal: SignalDraft | null }> {
  const u = await understand(p)
  if (!u.comparable) {
    reporter.note(`Market comparison not meaningful for "${p.description}": ${u.unknowns.join(", ") || "not a standard good"}.`, { paymentId: p.id })
    return { refs: [], signal: null }
  }
  const queries = u.queries.slice(0, 4)
  reporter.search(p.id, queries, `${u.item} (${u.unit})${u.unknowns.length ? `; unknown: ${u.unknowns.join(", ")}` : ""}`)

  // Several searches at the same time.
  const results = (await Promise.all(queries.map((query) => TOOLS.webSearch.invoke({ query }).catch(() => [])))).flat()
  const urls = [...new Map(results.map((r) => [r.url, r])).values()].slice(0, CONFIG.web.maxPagesPerPayment)

  // Read the pages and extract prices in parallel.
  const extracted = await Promise.all(
    urls.map(async (r) => {
      const page = await TOOLS.fetchPage.invoke({ url: r.url })
      if (!page.ok || !page.text) return null
      const e = await extract(p, u, r.url, page.title || r.title, page.text)
      if (!e.found || !e.normalizedPerUnitRsd || !e.price) return null
      const ref: PriceReference = {
        url: r.url,
        title: page.title || r.title,
        price: e.price,
        currency: e.currency ?? "RSD",
        normalizedRsd: e.normalizedPerUnitRsd,
        includes: [e.priceUnit, e.includes].filter(Boolean).join("; "),
        quote: e.quote,
      }
      reporter.offer(p.id, ref)
      return ref
    }),
  )
  const refs = extracted.filter((r): r is PriceReference => r !== null)

  // The Verifier checks every number against its page before the rule decides.
  const verified = refs.length ? await reporter.verifyPrices(p.id, refs) : []
  const decision = marketDecision(p, verified)
  if (decision.outcome !== "signal") {
    reporter.note(decision.note, { paymentId: p.id })
    return { refs: verified, signal: null }
  }
  return { refs: verified, signal: decision.signal }
}

/**
 * Before raising a price signal, look for a legitimate explanation in the
 * description. If found, it is written into the signal and the strength drops.
 */
async function justify(p: Payment, signal: SignalDraft): Promise<SignalDraft> {
  const r = await think<{ legitimate: boolean; explanation: string | null }>({
    role: "price",
    task: "justify_price",
    instruction: `You check whether a high price has a legitimate explanation stated in the payment record (for example: ${EXPLANATION_HINTS.join("; ")}). Only use what is written in the record. If nothing explains it, return legitimate=false. ${LANGUAGE_RULES}`,
    prompt: JSON.stringify({ description: p.description, category: p.category, unitPrice: formatRsd(unitPrice(p) ?? 0), signal: signal.summary }),
    schema: obj({ legitimate: bool(), explanation: nullable(str()) }),
    offline: () => {
      const e = findExplanation([p])
      return { legitimate: e !== null, explanation: e }
    },
  })
  if (!r.value.legitimate) return signal
  return { ...signal, strength: Math.max(0.1, signal.strength - 0.25), explanation: r.value.explanation }
}
