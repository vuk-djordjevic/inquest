import { useEffect, useState } from "react"
import { ROLE_LABEL, ROLE_ORDER } from "../api"
import type { LiveState } from "../live"

const ROLE_HINT: Record<string, string> = {
  coordinator: "queues payments, owns the case board, branches and merges",
  price: "peers, market offers on the internet, price rule",
  procedure: "OCP red flags on bids and procedures",
  patterns: "splitting, year-end spikes, repeats, plans",
  network: "business register, concentration, new firms",
  risk: "combines signals, looks for legitimate reasons",
  writer: "plain-language dossier from verified facts",
  verifier: "recomputes every number from the source",
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

export function AgentLanes({ live, onCase }: { live: LiveState; onCase: (id: number) => void }) {
  // Re-render every half second so activity dots fade out.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [])
  const now = Date.now()
  const roles = live.lanes.single ? ["single"] : ROLE_ORDER
  return (
    <div className="lanes">
      {roles.map((role) => {
        const items = live.lanes[role] ?? []
        const active = now - (live.lastActive[role] ?? 0) < 1200
        const screened = live.progress.screened[role]
        return (
          <div key={role} className="lane-wrap" data-role={role}>
            <section className="lane" aria-label={ROLE_LABEL[role]}>
              <div className="lane-head">
                <span className={`dot ${active ? "on" : ""}`} />
                <b title={ROLE_HINT[role]}>{ROLE_LABEL[role] ?? role}</b>
                <span className="count">{screened !== undefined ? `${screened} screened · ` : ""}{live.counts[role] ?? 0} events</span>
              </div>
              <ul className="lane-feed">
                {items.length === 0 && <li className="note">{ROLE_HINT[role]}</li>}
                {items.slice(0, 6).map((it) => (
                  <li key={it.id} className={it.tone ?? ""} onClick={() => it.caseId && onCase(it.caseId)} style={{ cursor: it.caseId ? "pointer" : undefined }}>
                    <time>{time(it.at)}</time>
                    {it.text}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )
      })}
    </div>
  )
}
