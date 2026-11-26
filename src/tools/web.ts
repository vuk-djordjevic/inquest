/**
 * Internet access for agents: search (Tavily or Brave) and page fetching.
 *
 * Every result is recorded in a SQLite cache (data/cache/web-cache.db). In
 * "cache" mode the agents replay recorded work, so a demo does not depend on
 * the network. The cache is the agents' remembered work with the original
 * links, not a hand-written table.
 */
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { CONFIG } from "../config.js"
import { runtimeState } from "../runtime/runtime.js"

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface FetchedPage {
  url: string
  title: string
  text: string
  ok: boolean
  error?: string
}

let cacheDb: Database.Database | null = null
function cache(): Database.Database {
  if (!cacheDb) {
    mkdirSync(dirname(CONFIG.webCachePath), { recursive: true })
    cacheDb = new Database(CONFIG.webCachePath)
    cacheDb.pragma("journal_mode = WAL")
    cacheDb.exec(`CREATE TABLE IF NOT EXISTS web_cache (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value_json TEXT NOT NULL, fetched_at TEXT NOT NULL)`)
  }
  return cacheDb
}

/**
 * Memoize an expensive agent step (e.g. an LLM price extraction from a page)
 * in the web cache, so recorded runs can be replayed without network or API key.
 */
export async function memo<T>(key: string, compute: () => Promise<{ value: T; cacheable: boolean }>): Promise<T> {
  const hit = cacheGet<T>(`memo:${key}`)
  if (hit !== undefined) return hit
  const { value, cacheable } = await compute()
  if (cacheable) cachePut(`memo:${key}`, "memo", value)
  return value
}

export function memoPeek<T>(key: string): T | undefined {
  return cacheGet<T>(`memo:${key}`)
}

function cacheGet<T>(key: string): T | undefined {
  const row = cache().prepare(`SELECT value_json FROM web_cache WHERE key = ?`).get(key) as { value_json: string } | undefined
  return row ? (JSON.parse(row.value_json) as T) : undefined
}

function cachePut(key: string, kind: string, value: unknown): void {
  cache()
    .prepare(`INSERT OR REPLACE INTO web_cache (key, kind, value_json, fetched_at) VALUES (?, ?, ?, ?)`)
    .run(key, kind, JSON.stringify(value), new Date().toISOString())
}

export function searchProvider(): "tavily" | "brave" | null {
  if (CONFIG.web.tavilyKey) return "tavily"
  if (CONFIG.web.braveKey) return "brave"
  return null
}

/** Describes where web answers come from in this run, for the UI and run report. */
export function webMode(): string {
  const provider = searchProvider()
  if (CONFIG.web.mode === "live" && provider) return `live (${provider}) + cache`
  return "recorded cache only"
}

export function webAvailable(): boolean {
  if (CONFIG.web.mode === "live" && searchProvider()) return true
  const row = cache().prepare(`SELECT COUNT(*) AS n FROM web_cache WHERE kind = 'search'`).get() as { n: number }
  return row.n > 0
}

const normalizeQuery = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ")

export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const key = `search:${normalizeQuery(query)}`
  const cached = cacheGet<SearchResult[]>(key)
  if (cached) return cached.slice(0, maxResults)
  const provider = searchProvider()
  if (CONFIG.web.mode !== "live" || !provider) return []
  runtimeState().counters.webSearches++
  const results = provider === "tavily" ? await tavily(query, maxResults) : await brave(query, maxResults)
  cachePut(key, "search", results)
  return results
}

async function tavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.web.tavilyKey}` },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
    signal: AbortSignal.timeout(CONFIG.web.fetchTimeoutMs),
  })
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`)
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> }
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 500) ?? "" }))
}

async function brave(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": CONFIG.web.braveKey ?? "" },
    signal: AbortSignal.timeout(CONFIG.web.fetchTimeoutMs),
  })
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`)
  const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description?.slice(0, 500) ?? "" }))
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  const key = `page:${url}`
  const cached = cacheGet<FetchedPage>(key)
  if (cached) return cached
  if (CONFIG.web.mode !== "live") return { url, title: "", text: "", ok: false, error: "not in cache" }
  runtimeState().counters.webPages++
  let page: FetchedPage
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "InquestResearchBot/0.1 (public-spending research prototype)", Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(CONFIG.web.fetchTimeoutMs),
      redirect: "follow",
    })
    const html = await res.text()
    page = { url, title: extractTitle(html), text: htmlToText(html).slice(0, 30_000), ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (error) {
    page = { url, title: "", text: "", ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (page.ok) cachePut(key, "page", page)
  return page
}

function extractTitle(html: string): string {
  return decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "")
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&euro;/g, "€")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** Is `quote` present on the cached page (whitespace- and case-insensitive)? Used by the Verifier. */
export function pageContains(url: string, quote: string): boolean {
  const page = cacheGet<FetchedPage>(`page:${url}`)
  if (!page?.text || !quote.trim()) return false
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  return norm(page.text).includes(norm(quote))
}
