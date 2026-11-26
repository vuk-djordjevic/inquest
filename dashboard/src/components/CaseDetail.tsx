import { marked } from "marked"
import { useEffect, useMemo, useState } from "react"
import { ROLE_LABEL, rsd, type CaseDetail as Detail } from "../api"

// Dossiers may contain text an LLM took from web pages: never render raw HTML, and only allow http(s) links.
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
marked.use({
  gfm: true,
  renderer: {
    html: (token) => escapeHtml(token.text),
    link(token) {
      const text = this.parser.parseInline(token.tokens)
      return /^https?:\/\//i.test(token.href) ? `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer noopener">${text}</a>` : text
    },
    image: (token) => escapeHtml(token.text),
  },
})

interface Rejection { factIndex: number | null; reason: string }

export function CaseDetail({ detail }: { detail: Detail | null }) {
  const [version, setVersion] = useState<number | null>(null)
  useEffect(() => setVersion(null), [detail?.case.id])
  const dossier = useMemo(() => {
    if (!detail?.dossiers.length) return null
    return detail.dossiers.find((d) => d.version === version) ?? detail.dossiers[detail.dossiers.length - 1]
  }, [detail, version])
  const html = useMemo(() => (dossier ? (marked.parse(dossier.body_md) as string) : ""), [dossier])

  if (!detail) return <div className="empty">Select a case to see its signals and dossier.</div>
  const c = detail.case
  const rejections = (dossier?.status === "rejected" ? ((dossier.checks as { rejections?: Rejection[] } | null)?.rejections ?? []) : []) as Rejection[]

  return (
    <div className="detail">
      <h3>#{c.id} {c.title}</h3>

      <div className="section">
        <h4>Dossier</h4>
        {!dossier && <div className="note">No dossier: the case is below the flag threshold or still being scored.</div>}
        {dossier && (
          <>
            <div className="version-tabs">
              {detail.dossiers.map((d) => (
                <button key={d.version} className={`btn ${d.version === dossier.version ? "primary" : ""}`} onClick={() => setVersion(d.version)}>
                  v{d.version} · {d.status}
                </button>
              ))}
            </div>
            {rejections.length > 0 && (
              <ol className="rejections">
                {rejections.map((r, i) => <li key={i}>Verifier: {r.reason}</li>)}
              </ol>
            )}
            <div className="dossier" dangerouslySetInnerHTML={{ __html: html }} />
          </>
        )}
      </div>

      <div className="section">
        <h4>Signals</h4>
        {detail.signals.map((s) => (
          <div key={s.id} className="signal-card">
            <div className="top">
              <b>{s.info.name}</b>
              {s.info.ocp && <span className="chip accent">OCP {s.info.ocp}</span>}
              <span className="chip">{ROLE_LABEL[s.agent] ?? s.agent}</span>
              <span className="bar" title={`strength ${s.strength.toFixed(2)}`}><i style={{ width: `${s.strength * 100}%` }} /></span>
            </div>
            <div>{s.summary}</div>
            <div className="rule">Rule: {s.rule}</div>
            {s.explanation && <div className="rule">Explanation found: {s.explanation}</div>}
          </div>
        ))}
      </div>

      {detail.merged.length > 0 && (
        <div className="section">
          <h4>Lines of investigation merged into this case</h4>
          <ul className="merges">
            {detail.merged.map((m) => (
              <li key={m.id}><b>#{m.id}</b> {m.title} {m.reason === "closed" ? "(branch closed, nothing new)" : ""}</li>
            ))}
          </ul>
        </div>
      )}

      {detail.findings.length > 0 && (
        <div className="section">
          <h4>Branch findings</h4>
          {detail.findings.map((f) => (
            <div key={f.id} className="signal-card">
              <div className="top"><span className="chip">{ROLE_LABEL[f.agent] ?? f.agent}</span><b>{f.entity.name ?? f.entity.id}</b></div>
              <div>{f.summary}</div>
            </div>
          ))}
        </div>
      )}

      {detail.priceRefs.length > 0 && (
        <div className="section">
          <h4>Market offers found by the Price agent</h4>
          <ul className="refs">
            {detail.priceRefs.map((r, i) => (
              <li key={i}>
                <span className={`chip ${r.verified ? "ok" : "risk"}`}>{r.verified ? "verified" : "rejected"}</span>{" "}
                {r.normalizedRsd ? rsd(r.normalizedRsd) + " / unit" : ""} — <a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url}</a>
                <div className="note">"{r.quote}"{r.verifyNote ? ` · ${r.verifyNote}` : ""}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

    </div>
  )
}
