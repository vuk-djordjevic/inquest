/**
 * The Price agent's market research path without network or API key:
 * a seeded web cache plays the internet, a fake model plays the LLM.
 * Checks: parallel searches -> page extraction -> Verifier drops a price whose
 * quote is not on the page -> rule on the median of verified offers.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import Database from "better-sqlite3"

const dir = mkdtempSync(join(tmpdir(), "inquest-test-"))
process.env.INQUEST_WEB_CACHE = join(dir, "web-cache.db")
process.env.INQUEST_WEB_MODE = "cache"
process.env.INQUEST_RUNS_DIR = join(dir, "runs")

const pages: Record<string, string> = {
  "https://a.example/kopaonik": "Đačka ekskurzija Kopaonik 2 dana. Cena 21.000 dinara po učeniku, polupansion.",
  "https://b.example/kop": "Kopaonik za škole: 2 dana / 1 noćenje - 19.500 RSD po učeniku uz prevoz.",
  "https://c.example/offer": "Ponuda: Kopaonik dvodnevna ekskurzija, 23.000 din po đaku.",
  "https://d.example/fake": "Ova stranica nema cene.",
}

function seedCache() {
  const db = new Database(process.env.INQUEST_WEB_CACHE!)
  db.exec(`CREATE TABLE IF NOT EXISTS web_cache (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`)
  const put = db.prepare(`INSERT OR REPLACE INTO web_cache VALUES (?, ?, ?, ?)`)
  const urls = Object.keys(pages)
  for (const q of ["kopaonik ekskurzija 2 dana cena", "kopaonik škola cena po učeniku"]) {
    put.run(`search:${q}`, "search", JSON.stringify(urls.map((url) => ({ title: url, url, snippet: "" }))), "2026-11-26")
  }
  for (const [url, text] of Object.entries(pages)) put.run(`page:${url}`, "page", JSON.stringify({ url, title: url, text, ok: true }), "2026-11-26")
  db.close()
}

test("market research: parallel search, extraction, verification, median rule", async () => {
  seedCache()
  const { ModelMessageItem, supportedModels } = await import("@mozaik-ai/core")
  const { CONFIG } = await import("../src/config.js")
  const { ensureRuntime } = await import("../src/runtime/runtime.js")
  const { CaseBoard } = await import("../src/db/board.js")
  const { getPayment } = await import("../src/db/source.js")
  const { resetPriceBudget, screenPrice } = await import("../src/skills/price-skill.js")
  const { verifyPriceRefs } = await import("../src/skills/verify-skill.js")

  const extraction: Record<string, unknown> = {
    "https://a.example/kopaonik": { found: true, price: 21000, currency: "RSD", priceUnit: "per student, 2 days", normalizedPerUnitRsd: 10500, includes: "half board", quote: "Cena 21.000 dinara po učeniku" },
    "https://b.example/kop": { found: true, price: 19500, currency: "RSD", priceUnit: "per student, 2 days", normalizedPerUnitRsd: 9750, includes: "transport", quote: "19.500 RSD po učeniku" },
    "https://c.example/offer": { found: true, price: 23000, currency: "RSD", priceUnit: "per student, 2 days", normalizedPerUnitRsd: 11500, includes: "", quote: "23.000 din po đaku" },
    // The model "hallucinates" a price that is not on the page: the Verifier must drop it.
    "https://d.example/fake": { found: true, price: 9000, currency: "RSD", priceUnit: "per student, 2 days", normalizedPerUnitRsd: 4500, includes: "", quote: "Cena 9.000 dinara" },
  }
  supportedModels.push({
    specification: { name: "fake-market-model", provider: "fake", supportsReasoningEffort: false, supportedReasoningEfforts: [], supportsStreaming: false, contextWindowSize: 100000, supportedContextItemTypes: [], maxOutputTokens: 4000, supportsFunctionCalling: false, supportsStructuredOutput: true },
    endpoint: {
      endpointMapper: { toRequest: (x: unknown) => x, toResponse: (x: unknown) => x as never },
      async infer(input) {
        const task = input.structuredOutput?.name
        const prompt = JSON.stringify(input.context.getItems().map((i) => (i as { content?: { text?: string } }).content?.text ?? ""))
        let out: unknown = {}
        if (task === "understand_payment") out = { item: "school excursion to Kopaonik, 2 days", unit: "per student per day", quantityInUnit: 90, unknowns: ["transport"], comparable: true, queries: ["Kopaonik ekskurzija 2 dana cena", "Kopaonik škola cena po učeniku"] }
        if (task === "extract_price") out = Object.entries(extraction).find(([url]) => prompt.includes(url))?.[1] ?? { found: false }
        if (task === "justify_price") out = { legitimate: false, explanation: null }
        return { items: [ModelMessageItem.rehydrate({ text: JSON.stringify(out) })], tokenUsage: undefined, rowResponse: null }
      },
      async *stream() {},
    },
  })

  const state = ensureRuntime()
  state.beginRun("market-test", "team", CaseBoard.fresh("team"))
  CONFIG.llm.enabled = true
  CONFIG.llm.modelFast = "fake-market-model"
  CONFIG.llm.modelSmart = "fake-market-model"
  CONFIG.llm.offlineLatencyMs = 0
  resetPriceBudget(5)

  const truth = JSON.parse(readFileSync(CONFIG.truthPath, "utf-8")) as { cases: Array<{ id: string; paymentIds: string[] }> }
  const t04 = getPayment(truth.cases.find((c) => c.id === "T04")!.paymentIds[0])!
  const searches: string[][] = []
  const result = await screenPrice(t04, {
    note: () => {},
    search: (_id, queries) => searches.push(queries),
    offer: () => {},
    verifyPrices: async (_id, refs) => verifyPriceRefs(refs),
  })

  assert.equal(searches.length, 1)
  assert.equal(result.refs.length, 4)
  assert.equal(result.refs.filter((r) => r.verified).length, 3, "the fabricated price must be rejected")
  const market = result.signals.find((s) => s.code === "MARKET_PRICE")
  assert.ok(market, "800 EUR per student is far above the verified market median")
  const median = market!.facts.find((f) => f.kind === "market_median")
  assert.deepEqual(median && { m: median.median, n: median.comparables }, { m: 10500, n: 3 })
  assert.ok(result.signals.some((s) => s.code === "PEER_PRICE"))
})
