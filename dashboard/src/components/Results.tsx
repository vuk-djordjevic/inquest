import { pct, type Comparison, type Evaluation, type RunStats, type ServerState } from "../api"

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="card">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

function StatsRow({ label, team, single }: { label: string; team: string | number; single: string | number }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{team}</td>
      <td className="num">{single}</td>
    </tr>
  )
}

export function Results({ evaluation, comparison, stats, state, real, onCase }: {
  evaluation: Evaluation | null
  comparison: Comparison | null
  stats: RunStats | null
  state: ServerState | null
  real: { payments: number; flaggedPayments: number; bySignal: Record<string, number> } | null
  onCase: (id: number) => void
}) {
  return (
    <div className="col">
      <section className="panel">
        <div className="panel-head"><h2>Accuracy on injected test cases</h2></div>
        <div className="panel-body">
          {!evaluation && <div className="empty">Run the team on the full dataset to evaluate.</div>}
          {evaluation && (
            <>
              {evaluation.scope.screenedPayments === 0 && (
                <p className="note" style={{ marginTop: 0 }}>
                  This run screened only real data ({evaluation.scope.realScreened.toLocaleString()} contracts). Accuracy can only be measured on the test data, where the truth is known; see "Real data" below.
                </p>
              )}
              {!evaluation.scope.full && evaluation.scope.screenedPayments > 0 && (
                <p className="note" style={{ marginTop: 0 }}>
                  This run screened {evaluation.scope.screenedPayments.toLocaleString()} of {evaluation.scope.totalPayments.toLocaleString()} payments.
                  Only the {evaluation.injected} injected cases inside that scope are counted; {evaluation.scope.injectedOutOfScope} are outside it.
                  The demo institutions were chosen because they contain test cases, so the flagged share here is higher than on the full data. Run "All test data" for the full evaluation.
                </p>
              )}
              <div className="cards">
                <Metric value={`${evaluation.detected}/${evaluation.injected}`} label="injected cases found" />
                <Metric value={pct(evaluation.correctSignalRate)} label="correct signal type" />
                <Metric value={pct(evaluation.expectedSignalRecall)} label="expected signals recovered" />
                <Metric value={evaluation.cleanPayments ? `${evaluation.falseAlarms}/${evaluation.cleanPayments}` : "n/a"} label="false alarms on clean payments" />
                <Metric value={pct(evaluation.flaggedShare.procurement, 1)} label="screened procurement payments flagged (target < 10%)" />
                <Metric value={evaluation.verifierCorrections} label="wrong claims caught by the Verifier" />
                {stats?.avgSecondsToApprovedDossier != null && <Metric value={`${stats.avgSecondsToApprovedDossier} s`} label="from payment to approved dossier" />}
              </div>
              <table className="data" style={{ marginTop: 14 }}>
                <thead>
                  <tr><th>Test case</th><th>Expected signal</th><th>Found signals</th><th className="num">Score</th></tr>
                </thead>
                <tbody>
                  {evaluation.cases.map((c) => (
                    <tr key={c.id} onClick={() => c.caseIds[0] && onCase(c.caseIds[0])} style={{ cursor: "pointer" }}>
                      <td>{c.detected ? "✔" : "✘"} <b>{c.id}</b> {c.title}</td>
                      <td><span className={`chip ${c.primaryFound ? "ok" : "risk"}`}>{c.primarySignal}</span></td>
                      <td>{c.foundSignals.map((s) => <span key={s} className="chip" style={{ marginRight: 3 }}>{state?.signals[s]?.ocp ?? s}</span>)}</td>
                      <td className="num">{c.score === null ? "-" : Math.round(c.score * 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">Accuracy is measured only on injected cases, where the truth is known. The ground-truth file is never read by the agents.</p>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Agent team vs. one agent</h2></div>
        <div className="panel-body">
          {!comparison && <div className="empty">Press "Compare" to process the same payments with the team and with a single sequential agent.</div>}
          {comparison && (
            <>
              <div className="cards" style={{ marginBottom: 12 }}>
                <Metric value={`${comparison.speedup.toFixed(1)}x`} label="faster with concurrent agents" />
                <Metric value={comparison.team.stats.mergedCases} label="lines of investigation merged (team)" />
              </div>
              <table className="data">
                <thead><tr><th /><th className="num">Agent team</th><th className="num">Single agent</th></tr></thead>
                <tbody>
                  <StatsRow label="Payments" team={comparison.team.stats.payments} single={comparison.single.stats.payments} />
                  <StatsRow label="Wall time" team={`${(comparison.team.stats.durationMs / 1000).toFixed(1)} s`} single={`${(comparison.single.stats.durationMs / 1000).toFixed(1)} s`} />
                  <StatsRow label="Flagged cases" team={comparison.team.stats.flaggedCases} single={comparison.single.stats.flaggedCases} />
                  <StatsRow label="Merged lines of investigation" team={comparison.team.stats.mergedCases} single={comparison.single.stats.mergedCases} />
                  <StatsRow label="Approved dossiers" team={comparison.team.stats.approvedDossiers} single={comparison.single.stats.approvedDossiers} />
                  <StatsRow label="Avg time to approved dossier" team={`${comparison.team.stats.avgSecondsToApprovedDossier ?? "-"} s`} single={`${comparison.single.stats.avgSecondsToApprovedDossier ?? "-"} s`} />
                  {comparison.team.evaluation && comparison.single.evaluation && (
                    <StatsRow label="Injected cases found" team={`${comparison.team.evaluation.detected}/${comparison.team.evaluation.injected}`} single={`${comparison.single.evaluation.detected}/${comparison.single.evaluation.injected}`} />
                  )}
                </tbody>
              </table>
              <p className="note">
                Both runs use the same skills, rules and prompts; only concurrency differs.
                LLM: {comparison.team.stats.llm.enabled ? `${comparison.team.stats.llm.modelFast} / ${comparison.team.stats.llm.modelSmart}` : "offline fallbacks with simulated latency"}.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Real data (aggregate only)</h2></div>
        <div className="panel-body">
          {!real && <p className="note">No real OCDS data loaded. Put OCDS release or record packages in <code>data/raw/real/</code> and rebuild the dataset. Real institutions are only ever shown in aggregate, never by name.</p>}
          {real && (
            <>
              <div className="cards">
                <Metric value={real.payments} label="real payments screened" />
                <Metric value={real.flaggedPayments} label="in flagged cases" />
              </div>
              <table className="data" style={{ marginTop: 12 }}>
                <thead><tr><th>Signal</th><th className="num">Payments</th></tr></thead>
                <tbody>{Object.entries(real.bySignal).map(([k, v]) => <tr key={k}><td>{state?.signals[k]?.name ?? k}</td><td className="num">{v}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
