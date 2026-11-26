/**
 * Mozaik Tool objects. Each agent declares the tools it may use, and reaches
 * data (database, internet, registers) only through them. The same objects can
 * be handed to an LLM agent loop.
 */
import type { Tool } from "@mozaik-ai/core"
import { getProcurementContext, paymentsByPayer, paymentsByRecipient, peerUnitPrices } from "../db/source.js"
import type { FetchedPage, SearchResult } from "./web.js"
import { fetchPage, webSearch } from "./web.js"
import { registryLookup } from "./registry.js"
import type { Payment, ProcurementContext, RegistryRecord } from "../domain/types.js"

function tool<A, R>(name: string, description: string, parameters: Record<string, unknown>, invoke: (args: A) => Promise<R>): Tool & {
  invoke: (args: A) => Promise<R>
} {
  return { type: "function", name, description, parameters, strict: true, invoke }
}

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

export const TOOLS = {
  webSearch: tool<{ query: string }, SearchResult[]>(
    "web_search",
    "Search the internet. Returns titles, URLs and snippets. Results are cached for replay.",
    objectSchema({ query: { type: "string" } }),
    async ({ query }) => webSearch(query),
  ),
  fetchPage: tool<{ url: string }, FetchedPage>(
    "fetch_page",
    "Download a web page and return its readable text.",
    objectSchema({ url: { type: "string" } }),
    async ({ url }) => fetchPage(url),
  ),
  registryLookup: tool<{ recipientId: string }, RegistryRecord | null>(
    "registry_lookup",
    "Look up a company in the business register by tax id: registration date, registered activity, status.",
    objectSchema({ recipientId: { type: "string" } }),
    async ({ recipientId }) => registryLookup(recipientId),
  ),
  paymentsByPayer: tool<{ payerId: string; group: string | null; from: string | null; to: string | null }, Payment[]>(
    "payments_by_payer",
    "All payments of a paying institution, optionally filtered by category group and date range.",
    objectSchema({
      payerId: { type: "string" },
      group: { type: ["string", "null"] },
      from: { type: ["string", "null"] },
      to: { type: ["string", "null"] },
    }),
    async ({ payerId, group, from, to }) => paymentsByPayer(payerId, { group: group ?? undefined, from: from ?? undefined, to: to ?? undefined }),
  ),
  paymentsByRecipient: tool<{ recipientId: string; from: string | null; to: string | null }, Payment[]>(
    "payments_by_recipient",
    "All payments received by a recipient across all institutions.",
    objectSchema({ recipientId: { type: "string" }, from: { type: ["string", "null"] }, to: { type: ["string", "null"] } }),
    async ({ recipientId, from, to }) => paymentsByRecipient(recipientId, { from: from ?? undefined, to: to ?? undefined }),
  ),
  peerPrices: tool<{ category: string; payerKind: string }, Array<{ id: string; payer_id: string; unit_price: number }>>(
    "peer_prices",
    "Unit prices paid for a category by all institutions of the same kind.",
    objectSchema({ category: { type: "string" }, payerKind: { type: "string" } }),
    async ({ category, payerKind }) => peerUnitPrices(category, payerKind),
  ),
  procurementContext: tool<{ paymentId: string }, ProcurementContext | null>(
    "procurement_context",
    "Procedure type, bids, tender period and amendments of a procurement contract.",
    objectSchema({ paymentId: { type: "string" } }),
    async ({ paymentId }) => getProcurementContext(paymentId) ?? null,
  ),
}
