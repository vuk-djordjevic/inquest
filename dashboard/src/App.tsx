import { useCallback, useEffect, useRef, useState } from "react"
import { api, type CaseDetail as Detail, type CaseSummary, type Comparison, type Evaluation, type GraphData, type Mode, type RunStats, type ServerState } from "./api"
import { useLive } from "./live"
import { AgentLanes } from "./components/AgentLanes"
import { CaseDetail } from "./components/CaseDetail"
import { CaseList } from "./components/CaseList"
import { Graph } from "./components/Graph"
import { Results } from "./components/Results"

type Tab = "live" | "cases" | "results"
type Scope = "demo" | "synthetic" | "real" | "real-sample"

// Contracts in the "Real procurement data, sample" scope: enough to watch the agents, quick and cheap with an LLM.
const REAL_SAMPLE = 5000

/** Demo payers: municipality X (laptops), municipality Z (street), school Y, plus two with legitimate look-alikes (GIS workstations, monthly rent). */
const DEMO_PAYERS = ["MU03", "MU07", "SC03", "SC08", "HE02", "MU04", "UT02"]

function useThrottled(fn: () => void, ms: number) {
  const last = useRef(0)
  const pending = useRef<number | null>(null)
  return useCallback(() => {
    const wait = last.current + ms - Date.now()
    if (wait <= 0) {
      last.current = Date.now()
      fn()
    } else if (pending.current === null) {
      pending.current = window.setTimeout(() => {
        pending.current = null
        last.current = Date.now()
        fn()
      }, wait)
    }
  }, [fn, ms])
}

export function App() {
  const [tab, setTab] = useState<Tab>("live")
  const [mode, setMode] = useState<Mode>("team")
  const [scope, setScope] = useState<Scope>("demo")
  const [state, setState] = useState<ServerState | null>(null)
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] })
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [real, setReal] = useState<Awaited<ReturnType<typeof api.realSummary>>>(null)
  const [showAll, setShowAll] = useState(false)

  const loadState = useCallback(() => api.state().then(setState).catch(() => {}), [])
  const loadCases = useCallback(() => api.cases(mode).then(setCases).catch(() => {}), [mode])
  const loadGraph = useCallback(() => api.graph(mode).then(setGraph).catch(() => {}), [mode])
  const loadDetail = useCallback(() => {
    if (selected !== null) api.caseDetail(mode, selected).then(setDetail).catch(() => setDetail(null))
  }, [mode, selected])
  const loadResults = useCallback(() => {
    api.evaluation(mode).then(setEvaluation).catch(() => setEvaluation(null))
    api.comparison().then(setComparison).catch(() => {})
    api.realSummary(mode).then(setReal).catch(() => {})
  }, [mode])

  const refreshCases = useThrottled(loadCases, 700)
  const refreshGraph = useThrottled(loadGraph, 2500)
  const refreshDetail = useThrottled(loadDetail, 900)

  const live = useLive((type) => {
    if (["case.updated", "cases.merged", "case.scored", "dossier.approved", "claim.rejected", "dossier.drafted"].includes(type)) {
      refreshCases()
      refreshGraph()
      refreshDetail()
    }
    if (type === "run.started") {
      setSelected(null)
      setDetail(null)
      loadState()
    }
    if (type === "run.settled" || type === "server.run_finished") {
      loadState()
      loadCases()
      loadGraph()
      loadResults()
    }
  })

  useEffect(() => {
    loadState()
  }, [loadState])
  useEffect(() => {
    loadCases()
    loadGraph()
    loadResults()
  }, [loadCases, loadGraph, loadResults])
  useEffect(() => {
    loadDetail()
  }, [loadDetail])

  // The server is the source of truth: live events can be missed (e.g. a reconnect), so poll its state during a run.
  const running = Boolean(state?.activeRun)
  useEffect(() => {
    if (!running && !live.running) return
    const timer = setInterval(loadState, 2000)
    return () => clearInterval(timer)
  }, [running, live.running, loadState])
  const start = async (m: "team" | "single" | "compare") => {
    if (m !== "compare") setMode(m)
    else setMode("team")
    const ok = await api.run(m, scope === "demo" ? { payers: DEMO_PAYERS } : scope === "real-sample" ? { dataset: "real", limit: REAL_SAMPLE } : { dataset: scope })
    if (ok) {
      setTab("live")
      loadState()
    }
  }
  const openCase = (id: number) => {
    setSelected(id)
    setTab("cases")
  }

  const runStats = (state?.runs[mode]?.stats ?? null) as RunStats | null
  const p = live.progress

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>Inquest</h1>
        </div>
        <nav className="tabs" aria-label="Main navigation">
          <button className={`tab ${tab === "live" ? "active" : ""}`} onClick={() => setTab("live")}>Live</button>
          <button className={`tab ${tab === "cases" ? "active" : ""}`} onClick={() => setTab("cases")}>Cases</button>
        </nav>
      </header>

      <main className="main">
        {tab === "live" && (
          <div className="live-page">
            <div className="live-toolbar">
              <select className="btn" value={scope} onChange={(e) => setScope(e.target.value as Scope)} disabled={running} aria-label="Payment data scope">
                <option value="demo">Demo institutions</option>
                <option value="synthetic">All test data ({((state?.dataset.payments ?? 0) - (state?.dataset.real ?? 0)).toLocaleString()} payments)</option>
                {(state?.dataset.real ?? 0) > REAL_SAMPLE && <option value="real-sample">Real procurement data, sample ({REAL_SAMPLE.toLocaleString()} contracts)</option>}
                {Boolean(state?.dataset.real) && <option value="real">Real procurement data ({state?.dataset.real.toLocaleString()} contracts)</option>}
              </select>
              <button className="btn primary" disabled={running} onClick={() => start("team")}>
                {running ? "Team running" : "Run agent team"}
              </button>
            </div>
            <section className="panel live-stats">
              <div className="progress">
                <div className="stat"><b>{p.queued.toLocaleString()}</b><span>payments queued</span></div>
                <div className="stat"><b>{(p.screened.price ?? p.screened.single ?? 0).toLocaleString()}</b><span>price-checked</span></div>
                {/* Real cases are hidden from the list by default, so after a run show the run's own totals. */}
                <div className="stat"><b>{(!running && runStats ? Math.max(runStats.cases, cases.length) : cases.length).toLocaleString()}</b><span>open cases</span></div>
                <div className="stat"><b>{!running && runStats ? Math.max(runStats.flaggedCases, cases.filter((c) => c.flagged).length) : cases.filter((c) => c.flagged).length}</b><span>flagged</span></div>
                <div className="stat"><b>{p.llm}</b><span>LLM calls</span></div>
                {runStats && !running && <div className="stat"><b>{(runStats.durationMs / 1000).toFixed(1)} s</b><span>last run</span></div>}
              </div>
            </section>
            <section className="panel agents-panel">
              <div className="panel-head"><h2>Agents</h2></div>
              <AgentLanes live={live} running={running} onCase={openCase} />
            </section>
            <section className="panel graph-panel">
              <div className="panel-head"><h2>Institutions and recipients</h2></div>
              <Graph data={graph} onCase={openCase} />
              <div className="legend">
                <span><i style={{ background: "var(--accent)", borderRadius: 2 }} />institution</span>
                <span><i style={{ background: "var(--faint)", borderRadius: "50%" }} />recipient</span>
                <span><i style={{ background: "var(--risk)" }} />in a flagged case</span>
                <span>click a link to open its case</span>
              </div>
            </section>
          </div>
        )}

        {tab === "cases" && (
          <div className="grid-cases">
            <section className="panel">
              <div className="panel-head">
                <h2>Ranked cases</h2>
                <div className="spacer" />
                <label className="note"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show unflagged</label>
              </div>
              <div className="panel-body" style={{ padding: 0 }}>
                {state && !state.showRealCases && (state.dataset.real ?? 0) > 0 && (
                  <div className="note" style={{ padding: "10px 14px" }}>
                    Cases from real procurement data are hidden; they are shown only as totals. To review them locally, set INQUEST_SHOW_REAL_CASES=1 in .env and restart the server.
                  </div>
                )}
                <CaseList cases={cases} selected={selected} onSelect={setSelected} state={state} showAll={showAll} />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Case file</h2></div>
              <div className="panel-body"><CaseDetail detail={detail} /></div>
            </section>
          </div>
        )}

        {tab === "results" && <Results evaluation={evaluation} comparison={comparison} stats={runStats} state={state} real={real} onCase={openCase} />}
      </main>
    </div>
  )
}
