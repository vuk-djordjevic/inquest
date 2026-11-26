/**
 * Inquest server: JSON API for the dashboard, a server-sent events stream of
 * live agent events, and the built dashboard (dashboard/dist).
 *
 *   npm run serve   ->   http://localhost:8787
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize, resolve } from "node:path"
import { liveBus, type LiveEvent } from "../agents/recorder.js"
import { CONFIG, REFERENCE, ROOT } from "../config.js"
import { CaseBoard, type BoardMode } from "../db/board.js"
import { datasetStats, getPayments, sourceDb } from "../db/source.js"
import { SIGNALS } from "../domain/signal-catalog.js"
import { evaluate } from "../eval/evaluate.js"
import { COMPARISON_PATH, compare } from "../run/compare.js"
import { runSingle } from "../run/single.js"
import { runTeam } from "../run/team.js"
import type { PaymentFilter } from "../db/source.js"
import { webMode } from "../tools/web.js"

const DIST = resolve(ROOT, "dashboard", "dist")
let activeRun: { mode: string; startedAt: number } | null = null
let lastError: string | null = null

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
  } catch {
    return {}
  }
}

/** Boards are reopened per request, so a run that just finished is always visible. */
function withBoard<T>(mode: BoardMode, fn: (b: CaseBoard) => T): T | null {
  const board = CaseBoard.open(mode)
  if (!board) return null
  try {
    return fn(board)
  } finally {
    board.close()
  }
}

const modeOf = (url: URL): BoardMode => (url.searchParams.get("mode") === "single" ? "single" : "team")

function casesView(b: CaseBoard) {
  return b.listCases().map((c) => {
    const signals = b.caseSignals(c.id)
    const dossiers = b.dossiers(c.id)
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      score: c.score,
      priority: c.priority,
      hop: c.hop,
      parentId: c.parent_id,
      flagged: (c.score ?? 0) >= CONFIG.investigation.flagThreshold,
      signals: [...new Set(signals.map((s) => s.code))],
      agents: [...new Set(signals.map((s) => s.agent))],
      payments: b.casePaymentIds(c.id).length,
      dossierVersions: dossiers.length,
      dossierStatus: dossiers.at(-1)?.status ?? null,
      dataset: getPayments(b.casePaymentIds(c.id).slice(0, 1))[0]?.dataset ?? "synthetic",
    }
  })
}

function caseDetail(b: CaseBoard, id: number) {
  const c = b.getCase(id)
  if (!c) return null
  const paymentIds = b.casePaymentIds(id)
  const payments = getPayments(paymentIds)
  const merged = b.listCases({ includeMerged: true }).filter((x) => x.merged_into === id).map((x) => ({ id: x.id, title: x.title, reason: x.merge_reason }))
  return {
    case: c,
    signals: b.caseSignals(id).map((s) => ({ ...s, info: SIGNALS[s.code] })),
    findings: b.caseFindings(id),
    entities: b.caseEntities(id),
    payments,
    priceRefs: b.priceRefs(paymentIds),
    dossiers: b.dossiers(id),
    merged,
  }
}

function graphView(b: CaseBoard) {
  const nodes = new Map<string, { id: string; label: string; type: "payer" | "recipient"; flagged: boolean; kind?: string }>()
  const edges = new Map<string, { id: string; source: string; target: string; amount: number; count: number; flagged: boolean; cases: number[] }>()
  for (const c of b.listCases()) {
    const flagged = (c.score ?? 0) >= CONFIG.investigation.flagThreshold
    for (const p of getPayments(b.casePaymentIds(c.id))) {
      if (p.dataset === "real") continue // real data is shown only in aggregate
      const payer = `payer:${p.payer_id}`
      const recipient = `recipient:${p.recipient_id}`
      const pn = nodes.get(payer) ?? { id: payer, label: p.payer_name, type: "payer" as const, flagged: false, kind: p.payer_kind }
      pn.flagged ||= flagged
      nodes.set(payer, pn)
      const rn = nodes.get(recipient) ?? { id: recipient, label: p.recipient_name, type: "recipient" as const, flagged: false }
      rn.flagged ||= flagged
      nodes.set(recipient, rn)
      const key = `${payer}->${recipient}`
      const e = edges.get(key) ?? { id: key, source: payer, target: recipient, amount: 0, count: 0, flagged: false, cases: [] }
      e.amount += p.amount
      e.count++
      e.flagged ||= flagged
      if (!e.cases.includes(c.id)) e.cases.push(c.id)
      edges.set(key, e)
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

/** Real data is only ever shown in aggregate: how many payments per signal, no names. */
function realSummary(b: CaseBoard) {
  const real = (sourceDb().prepare(`SELECT COUNT(*) AS n FROM payments WHERE dataset = 'real'`).get() as { n: number }).n
  if (!real) return null
  const counts: Record<string, number> = {}
  const flaggedPayments = new Set<string>()
  for (const c of b.listCases()) {
    for (const s of b.caseSignals(c.id)) {
      const realIds = getPayments(s.paymentIds).filter((p) => p.dataset === "real")
      if (realIds.length) counts[s.code] = (counts[s.code] ?? 0) + realIds.length
      if ((c.score ?? 0) >= CONFIG.investigation.flagThreshold) realIds.forEach((p) => flaggedPayments.add(p.id))
    }
  }
  return { payments: real, flaggedPayments: flaggedPayments.size, bySignal: counts }
}

function startRun(mode: string, filter: PaymentFilter): boolean {
  if (activeRun) return false
  activeRun = { mode, startedAt: Date.now() }
  lastError = null
  const job = mode === "single" ? runSingle(filter) : mode === "compare" ? compare(filter) : runTeam(filter)
  job
    .catch((e: unknown) => {
      lastError = e instanceof Error ? e.message : String(e)
      console.error("[run]", e)
    })
    .finally(() => {
      activeRun = null
      liveBus.emit("event", { id: 0, at: Date.now(), type: "server.run_finished", producer: "server", role: null, payload: { mode, error: lastError } } satisfies LiveEvent)
    })
  return true
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname
  if (path === "/api/state") {
    const team = withBoard("team", (b) => b.lastRun())
    const single = withBoard("single", (b) => b.lastRun())
    return json(res, 200, {
      activeRun,
      lastError,
      dataset: datasetStats(),
      llm: { enabled: CONFIG.llm.enabled, modelFast: CONFIG.llm.modelFast, modelSmart: CONFIG.llm.modelSmart, language: CONFIG.llm.reportLanguage },
      web: webMode(),
      runs: { team, single },
      flagThreshold: CONFIG.investigation.flagThreshold,
      signals: SIGNALS,
      categories: REFERENCE.categories,
    })
  }
  if (path === "/api/cases") return json(res, 200, withBoard(modeOf(url), casesView) ?? [])
  const caseMatch = path.match(/^\/api\/cases\/(\d+)$/)
  if (caseMatch) {
    const d = withBoard(modeOf(url), (b) => caseDetail(b, Number(caseMatch[1])))
    return d ? json(res, 200, d) : json(res, 404, { error: "case not found" })
  }
  if (path === "/api/graph") return json(res, 200, withBoard(modeOf(url), graphView) ?? { nodes: [], edges: [] })
  if (path === "/api/events") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 400), 5000)
    const rows = withBoard(modeOf(url), (b) =>
      (b.db.prepare(`SELECT * FROM events WHERE type NOT IN ('inference.started','inference.completed') ORDER BY id DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>)
        .reverse()
        .map((r) => ({ id: r.id, at: r.at_ms, type: r.type, producer: r.producer, role: r.producer_role, payload: JSON.parse((r.payload_json as string) ?? "null") })),
    )
    return json(res, 200, rows ?? [])
  }
  if (path === "/api/eval") {
    try {
      return json(res, 200, withBoard(modeOf(url), (b) => evaluate(b)))
    } catch (e) {
      return json(res, 200, null)
    }
  }
  if (path === "/api/real-summary") return json(res, 200, withBoard(modeOf(url), realSummary))
  if (path === "/api/comparison") return json(res, 200, existsSync(COMPARISON_PATH) ? JSON.parse(readFileSync(COMPARISON_PATH, "utf-8")) : null)
  if (path === "/api/run" && req.method === "POST") {
    const body = await readBody(req)
    const mode = String(body.mode ?? "team")
    const filter: PaymentFilter = {
      payerIds: Array.isArray(body.payers) && body.payers.length ? body.payers.map(String) : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    }
    return startRun(mode, filter) ? json(res, 202, { started: mode }) : json(res, 409, { error: "a run is already in progress" })
  }
  if (path === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    res.write(": connected\n\n")
    const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`)
    // Per-payment events are too many for a browser; they are folded into a progress message.
    const progress = { queued: 0, screened: {} as Record<string, number>, llm: 0, dirty: false }
    const send = (e: LiveEvent) => {
      if (e.type === "run.started") {
        progress.queued = 0
        progress.screened = {}
        progress.llm = 0
      }
      if (e.type === "contract.queued") {
        progress.queued++
        progress.dirty = true
        return
      }
      if (e.type === "payment.screened") {
        const role = e.role ?? "?"
        progress.screened[role] = (progress.screened[role] ?? 0) + 1
        progress.dirty = true
        if ((e.payload as { signals?: number }).signals) write(e)
        return
      }
      if (e.type === "inference.started") {
        progress.llm++
        progress.dirty = true
      }
      write(e)
    }
    const flush = setInterval(() => {
      if (!progress.dirty) return
      progress.dirty = false
      write({ id: 0, at: Date.now(), type: "progress", producer: "server", role: null, payload: { queued: progress.queued, screened: progress.screened, llm: progress.llm } })
    }, 250)
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000)
    liveBus.on("event", send)
    req.on("close", () => {
      clearInterval(heartbeat)
      clearInterval(flush)
      liveBus.off("event", send)
    })
    return
  }
  return json(res, 404, { error: "not found" })
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
}

function serveStatic(res: ServerResponse, url: URL): void {
  if (!existsSync(DIST)) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Dashboard not built. Run `npm run dashboard:build` (or `npm run dashboard:dev` for development).")
    return
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "")
  let file = join(DIST, rel)
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html")
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" })
  createReadStream(file).pipe(res)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((e: unknown) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }))
  } else serveStatic(res, url)
})

server.listen(CONFIG.server.port, () => {
  console.log(`Inquest server on http://localhost:${CONFIG.server.port}`)
  console.log(`LLM: ${CONFIG.llm.enabled ? `${CONFIG.llm.modelFast} / ${CONFIG.llm.modelSmart}` : "offline fallbacks"} · web: ${webMode()}`)
})
