/**
 * Dossier-writer agent skill. Builds the fact sheet of a case (every number
 * the dossier may state, each tied to source records) and writes the dossier.
 * Facts corrected by the Verifier replace the originals in later versions.
 */
import type { CaseBoard } from "../db/board.js"
import { getPayments } from "../db/source.js"
import { SIGNALS } from "../domain/signal-catalog.js"
import type { Fact } from "../domain/types.js"
import { LANGUAGE_RULES, arr, obj, reportLanguageInstruction, str, think } from "../llm/think.js"
import { formatRsd, round } from "../signals/stats.js"
import { factKey, factSentence } from "./facts.js"
import type { Rejection } from "../runtime/events.js"

export interface DossierInput {
  caseId: number
  version: number
  /** Corrections from the Verifier: fact JSON -> corrected fact, or null to drop an unverifiable fact. */
  corrections: Map<string, Fact | null>
  /** Problems the Verifier found in the previous version's prose. */
  proseProblems: string[]
}

export interface WrittenDossier {
  title: string
  bodyMd: string
  facts: Fact[]
}

export function buildFactSheet(board: CaseBoard, caseId: number, corrections: Map<string, Fact | null>): Fact[] {
  const seen = new Set<string>()
  const facts: Fact[] = []
  const add = (f: Fact) => {
    // Follow correction chains (a corrected fact may itself be corrected in a later round).
    let fixed: Fact | null = f
    for (let i = 0; i < 5 && fixed && corrections.has(factKey(fixed)); i++) fixed = corrections.get(factKey(fixed)) ?? null
    if (!fixed) return
    const k = factKey(fixed)
    if (!seen.has(k)) {
      seen.add(k)
      facts.push(fixed)
    }
  }
  for (const s of board.caseSignals(caseId)) s.facts.forEach(add)
  for (const f of board.caseFindings(caseId)) f.facts.forEach(add)
  return facts
}

export async function writeDossier(board: CaseBoard, input: DossierInput): Promise<WrittenDossier> {
  const c = board.getCase(input.caseId)!
  const signals = board.caseSignals(input.caseId)
  const findings = board.caseFindings(input.caseId)
  const facts = buildFactSheet(board, input.caseId, input.corrections)
  const payments = getPayments(board.casePaymentIds(input.caseId))
  const refs = board.priceRefs(payments.map((p) => p.id)).filter((r) => r.verified)

  const factList = facts.map((f, i) => `F${i + 1}. ${factSentence(f)}`).join("\n")
  const paymentTable = [
    "| Payment | Date | Payer | Recipient | Amount | Description | Source record |",
    "|---|---|---|---|---:|---|---|",
    ...payments.slice(0, 30).map((p) =>
      `| ${p.id} | ${p.date} | ${p.payer_name} | ${p.recipient_name} | ${formatRsd(p.amount)} | ${(p.description ?? "").replace(/\|/g, "/")}${p.status === "cancelled" ? " (cancelled)" : ""} | \`${p.source_ref}\` |`,
    ),
    payments.length > 30 ? `\n_${payments.length - 30} more payments in the case are not listed._` : "",
  ].join("\n")
  const marketSection = refs.length
    ? `## Market comparison\n\n${refs.map((r) => `- ${r.normalizedRsd ? formatRsd(r.normalizedRsd) + " per unit" : ""} — [${r.title || r.url}](${r.url}) — "${r.quote}"${r.includes ? ` (${r.includes})` : ""}`).join("\n")}\n`
    : ""
  const footer = `---\n_Risk signals are not proof of wrongdoing. A flagged case may be fully legitimate, poorly executed, or worth deeper review; a person decides what happens next. Every number above comes from the listed source records or linked pages and was checked by the Verifier._`

  const r = await think<{ title: string; summary: string; signalsSection: string; explanationsSection: string }>({
    role: "writer",
    task: "write_dossier",
    model: "smart",
    caseId: input.caseId,
    maxOutputTokens: 3000,
    instruction: `You are the Dossier writer of a public-spending risk screening team. You explain to a journalist or auditor, in plain language, why a case is worth checking. You may only use the numbered facts (cite them like [F2]) and the signal descriptions. If a signal description conflicts with a fact, the fact is correct. Keep it short and concrete. ${LANGUAGE_RULES} ${reportLanguageInstruction()}`,
    prompt: JSON.stringify({
      riskScore: c.score,
      scoreRationale: (c as unknown as { score_rationale?: string }).score_rationale ?? null,
      signals: signals.map((s) => ({ name: SIGNALS[s.code].name, ocp: SIGNALS[s.code].ocp, rule: s.rule, explanation: s.explanation })),
      branchFindings: findings.map((f) => ({ agent: f.agent, entity: f.entity })),
      facts: factList,
      problemsInPreviousVersion: input.proseProblems,
    }),
    schema: obj({
      title: str("neutral case title, max 90 characters"),
      summary: str("2-3 sentences: what was found and why it is worth checking"),
      signalsSection: str("markdown bullet list, one bullet per signal with fact citations"),
      explanationsSection: str("legitimate explanations considered, or 'None found in the records.'"),
    }),
    offline: () => templateDossier(input.caseId, board, facts),
  })

  const v = r.value
  const bodyMd = [
    `# ${v.title}`,
    `**Risk score:** ${round((c.score ?? 0) * 100)}/100 · **Signals:** ${signals.length} · **Payments in case:** ${payments.length} · **Version:** ${input.version}`,
    `## Summary\n\n${v.summary}`,
    `## Why this is worth checking\n\n${v.signalsSection}`,
    `## Legitimate explanations considered\n\n${v.explanationsSection}`,
    `## Facts\n\n${factList}`,
    marketSection,
    `## Source records\n\n${paymentTable}`,
    footer,
  ].filter(Boolean).join("\n\n")
  return { title: v.title, bodyMd, facts }
}

/** Deterministic dossier used without an LLM. Numbers come only from facts. */
function templateDossier(caseId: number, board: CaseBoard, facts: Fact[]): { title: string; summary: string; signalsSection: string; explanationsSection: string } {
  const c = board.getCase(caseId)!
  const signals = board.caseSignals(caseId)
  const findIdx = (pred: (f: Fact) => boolean) => facts.map((f, i) => (pred(f) ? `[F${i + 1}]` : "")).filter(Boolean).join("")
  const bullets = signals.map((s) => {
    const info = SIGNALS[s.code]
    const own = new Set(s.facts.map(factKey))
    const cites = findIdx((f) => own.has(factKey(f)) || s.facts.some((sf) => sf.kind === f.kind && sameSubject(sf, f)))
    // Sentences are rendered from the (possibly corrected) facts, never from the signal's own summary,
    // so a number the Verifier corrected cannot survive in the prose.
    const current = s.facts.map((sf) => facts.find((f) => f.kind === sf.kind && sameSubject(sf, f))).filter((f): f is Fact => Boolean(f))
    const text = current.length ? [...new Set(current.map(factSentence))].join(" ") : info.description
    return `- **${info.name}**${info.ocp ? ` (OCP ${info.ocp})` : ""}: ${text} ${cites}\n  _Rule: ${s.rule}_${s.explanation ? `\n  _Explanation found: ${s.explanation}_` : ""}`
  })
  const explanations = signals.filter((s) => s.explanation).map((s) => `- ${s.explanation}`)
  const caseExplanation = (c as unknown as { explanation?: string | null }).explanation
  if (caseExplanation) explanations.push(`- ${caseExplanation}`)
  const names = [...new Set(signals.map((s) => SIGNALS[s.code].name.toLowerCase()))]
  return {
    title: c.title,
    summary: `${signals.length} risk signal(s) point at this case: ${names.join(", ")}. ${signals.length > 1 ? "Several signals on the same payer or recipient make it worth a closer look." : "One signal alone may have an ordinary explanation."}`,
    signalsSection: bullets.join("\n"),
    explanationsSection: explanations.length ? explanations.join("\n") : "None found in the records.",
  }
}

/** Do two facts describe the same subject (so a corrected fact replaces the signal's original)? */
function sameSubject(a: Fact, b: Fact): boolean {
  const pick = (f: Fact) => {
    const o = f as Record<string, unknown>
    return JSON.stringify([o.kind, o.paymentId, o.payerId, o.recipientId, o.group, o.category, o.year, o.url])
  }
  return pick(a) === pick(b)
}

/** Turn the Verifier's rejections into corrections for the next version; returns remaining prose problems. */
export function rejectionsToCorrections(facts: Fact[], rejections: Rejection[], corrections: Map<string, Fact | null>): string[] {
  const proseProblems: string[] = []
  for (const r of rejections) {
    if (r.factIndex !== null && facts[r.factIndex]) corrections.set(factKey(facts[r.factIndex]), r.corrected ?? null)
    else proseProblems.push(r.reason)
  }
  return proseProblems
}
