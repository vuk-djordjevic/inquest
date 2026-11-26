import { useEffect, useRef, useState } from "react"
import type { LiveEvent } from "./api"

export interface FeedItem {
  id: string
  at: number
  text: string
  tone?: "hl" | "risk" | "ok"
  caseId?: number
}

export interface LiveState {
  connected: boolean
  running: boolean
  progress: { queued: number; screened: Record<string, number>; llm: number }
  lanes: Record<string, FeedItem[]>
  counts: Record<string, number>
  lastActive: Record<string, number>
  merges: FeedItem[]
  stats: unknown
}

const EMPTY: LiveState = {
  connected: false,
  running: false,
  progress: { queued: 0, screened: {}, llm: 0 },
  lanes: {},
  counts: {},
  lastActive: {},
  merges: [],
  stats: null,
}

const short = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const name = (e: { name?: string; id: string }) => e.name ?? e.id

/** One line per event, from the perspective of the agent that produced it. */
export function describe(e: LiveEvent): FeedItem | null {
  const p = e.payload ?? {}
  const base = { id: `${e.type}-${e.id}-${e.at}`, at: e.at }
  switch (e.type) {
    case "signal.raised":
      return { ...base, text: `${p.signal.code}: ${short(p.signal.summary)}`, tone: "risk" }
    case "case.updated":
      return p.created ? { ...base, text: `opened case #${p.caseId} (${p.signalCode})`, tone: "hl", caseId: p.caseId } : null
    case "entity.flagged":
      return { ...base, text: `branch → ${p.entity.type} ${name(p.entity)} (#${p.caseId}, hop ${p.hop}): ${short(p.reason, 80)}`, tone: "hl", caseId: p.caseId }
    case "entity.claimed":
      return { ...base, text: p.claimed ? `claimed ${name(p.entity)}` : `${name(p.entity)} already claimed by case #${p.ownerCaseId} - joining it` }
    case "finding.reported":
      return { ...base, text: short(p.finding.summary, 140), caseId: p.finding.caseId }
    case "cases.merged":
      return { ...base, text: `merged #${p.merged.join(", #")} into #${p.survivor}: ${p.reason}`, tone: "hl", caseId: p.survivor }
    case "case.scored":
      return { ...base, text: `case #${p.caseId} scored ${Math.round(p.score * 100)}${p.flagged ? " - flagged" : ""}`, tone: p.flagged ? "risk" : undefined, caseId: p.caseId }
    case "price.search":
      return { ...base, text: `searching: ${p.queries.map((q: string) => `"${q}"`).join(", ")}`, tone: "hl" }
    case "price.offer":
      return { ...base, text: `offer ${Math.round(p.ref.normalizedRsd).toLocaleString()} RSD/unit - ${short(p.ref.title || p.ref.url, 60)}` }
    case "prices.verified": {
      const ok = p.refs.filter((r: { verified?: boolean }) => r.verified).length
      return { ...base, text: `checked ${p.refs.length} market prices against their pages: ${ok} confirmed`, tone: "ok" }
    }
    case "dossier.drafted":
      return { ...base, text: `drafted dossier v${p.version} for case #${p.caseId}`, caseId: p.caseId }
    case "claim.rejected":
      return { ...base, text: `rejected v${p.version} of #${p.caseId}: ${short(p.rejections.map((r: { reason: string }) => r.reason).join("; "), 140)}`, tone: "risk", caseId: p.caseId }
    case "dossier.approved":
      return { ...base, text: `approved dossier v${p.version} of case #${p.caseId}`, tone: "ok", caseId: p.caseId }
    case "agent.note":
      return { ...base, text: short(p.text, 140) }
    case "agent.error":
      return { ...base, text: `error: ${short(p.message, 120)}`, tone: "risk" }
    case "payment.screened":
      return p.signals ? { ...base, text: `payment ${p.paymentId}: ${p.signals} signal(s)` } : null
    default:
      return null
  }
}

/** Subscribe to the server-sent event stream and keep per-agent feeds. */
export function useLive(onChange: (type: string) => void): LiveState {
  const [state, setState] = useState<LiveState>(EMPTY)
  const buffer = useRef<LiveEvent[]>([])
  const cb = useRef(onChange)
  cb.current = onChange

  useEffect(() => {
    const es = new EventSource("/api/stream")
    es.onopen = () => setState((s) => ({ ...s, connected: true }))
    es.onerror = () => setState((s) => ({ ...s, connected: false }))
    es.onmessage = (m) => buffer.current.push(JSON.parse(m.data) as LiveEvent)

    // Apply buffered events a few times per second, so thousands of events don't re-render thousands of times.
    const timer = setInterval(() => {
      const batch = buffer.current.splice(0)
      if (!batch.length) return
      const types = new Set<string>()
      setState((prev) => {
        let s = prev
        for (const e of batch) {
          types.add(e.type)
          if (e.type === "run.started") s = { ...EMPTY, connected: true, running: true }
          else if (e.type === "run.settled") s = { ...s, running: false, stats: e.payload }
          else if (e.type === "server.run_finished") s = { ...s, running: false }
          else if (e.type === "progress") s = { ...s, running: true, progress: e.payload }
          const role = e.role ?? (e.type === "progress" ? null : "coordinator")
          if (role && e.type !== "progress") {
            s = { ...s, lastActive: { ...s.lastActive, [role]: Date.now() }, counts: { ...s.counts, [role]: (s.counts[role] ?? 0) + 1 } }
          }
          const item = describe(e)
          if (item && role) s = { ...s, lanes: { ...s.lanes, [role]: [item, ...(s.lanes[role] ?? [])].slice(0, 30) } }
          if (item && e.type === "cases.merged") s = { ...s, merges: [item, ...s.merges].slice(0, 30) }
        }
        return s
      })
      types.forEach((t) => cb.current(t))
    }, 250)
    return () => {
      clearInterval(timer)
      es.close()
    }
  }, [])
  return state
}
