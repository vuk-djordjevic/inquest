import type { CaseSummary, ServerState } from "../api"

export function scoreClass(score: number | null, threshold: number) {
  if (score === null) return ""
  return score >= 0.75 ? "high" : score >= threshold ? "mid" : ""
}

export function CaseList({ cases, selected, onSelect, state, showAll }: {
  cases: CaseSummary[]
  selected: number | null
  onSelect: (id: number) => void
  state: ServerState | null
  showAll: boolean
}) {
  const threshold = state?.flagThreshold ?? 0.5
  const visible = showAll ? cases : cases.filter((c) => c.flagged)
  if (!visible.length) return <div className="empty">No {showAll ? "" : "flagged "}cases yet. Start a run.</div>
  return (
    <ul className="case-list">
      {visible.map((c) => (
        <li key={c.id} className={`case-row ${selected === c.id ? "selected" : ""}`} onClick={() => onSelect(c.id)}>
          <div className={`score ${scoreClass(c.score, threshold)}`}>{c.score === null ? "…" : Math.round(c.score * 100)}</div>
          <div style={{ minWidth: 0 }}>
            <div className="title" title={c.title}>#{c.id} {c.title}</div>
            <div className="meta">
              {c.signals.map((s) => (
                <span key={s} className="chip" title={state?.signals[s]?.name}>{state?.signals[s]?.ocp ?? s}</span>
              ))}
            </div>
            <div className="meta">
              <span className={`chip ${c.status === "approved" ? "ok" : c.status === "drafted" ? "warn" : ""}`}>{c.status}</span>
              {c.priority > 0 && <span className="chip warn" title="Independent lines of investigation met in this case">{c.priority} merge{c.priority > 1 ? "s" : ""}</span>}
              {c.parentId && <span className="chip accent">branch of #{c.parentId}</span>}
              <span className="chip">{c.payments} payment{c.payments === 1 ? "" : "s"}</span>
              <span className="chip">{c.agents.length} agent{c.agents.length === 1 ? "" : "s"}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
