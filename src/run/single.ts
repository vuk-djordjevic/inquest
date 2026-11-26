/**
 * Single-agent baseline for the jury comparison.
 *
 * One agent does exactly the same work with exactly the same skills, rules and
 * LLM prompts as the team, but one step at a time: for each payment it checks
 * price, procedure, patterns and recipient in order, follows each branch
 * investigation to the end before moving on, then scores, writes and verifies
 * dossiers one by one. The only difference from the team run is concurrency.
 */
import { createAgent } from "@mozaik-ai/core"
import { CONFIG } from "../config.js"
import { CaseBoard } from "../db/board.js"
import { getPayment, listPaymentIds, type PaymentFilter } from "../db/source.js"
import type { EntityRef, Fact, SignalDraft } from "../domain/types.js"
import { createRecorder } from "../agents/recorder.js"
import { windowAround } from "../agents/common.js"
import { llmEnabled, resetLlmBudget } from "../llm/think.js"
import { EV, type ContractQueued, type RunStarted } from "../runtime/events.js"
import { emit, ensureRuntime, join, leave } from "../runtime/runtime.js"
import { decideBranches } from "../skills/branch-skill.js"
import { rejectionsToCorrections, writeDossier } from "../skills/dossier-skill.js"
import { investigateRecipient, resetRegistryMemo, screenRecipient } from "../skills/network-skill.js"
import { investigatePayer, screenPatterns } from "../skills/patterns-skill.js"
import { resetPriceBudget, screenPrice } from "../skills/price-skill.js"
import { screenProcedure } from "../skills/procedure-skill.js"
import type { Reporter } from "../skills/reporter.js"
import { scoreCase } from "../skills/risk-skill.js"
import { verifyDossier, verifyPriceRefs } from "../skills/verify-skill.js"
import { webMode } from "../tools/web.js"
import { collectStats, type RunStats } from "./stats.js"
import { isRunning } from "./team.js"

export async function runSingle(filter: PaymentFilter = {}): Promise<RunStats> {
  if (isRunning()) throw new Error("A run is already in progress")
  const state = ensureRuntime()
  const board = CaseBoard.fresh("single")
  const runId = `single-${new Date().toISOString().replace(/[:.]/g, "-")}`
  state.beginRun(runId, "single", board)
  board.startRun(runId, "single")
  resetLlmBudget()
  resetPriceBudget()
  resetRegistryMemo()

  const recorder = createRecorder()
  const solo = createAgent({ name: "Solo investigator", capabilities: ["role:single"], instruction: "Checks every signal of every payment in order.", tools: [], handlers: [] })
  state.roles.set(solo.getId(), "single")
  join(recorder)
  join(solo)

  const reporter: Reporter = {
    note: (text, ref) => board.addNote("single", ref?.paymentId ?? null, text),
    search: (paymentId, queries) => board.addNote("single", paymentId, `searching: ${queries.join(" | ")}`),
    offer: () => {},
    verifyPrices: async (_paymentId, refs) => verifyPriceRefs(refs),
  }
  const flagged = new Set<string>()
  const decided = new Set<string>()

  const attach = async (signals: SignalDraft[], hop: number, caseHint?: number) => {
    for (const s of signals) {
      const r = board.attachSignal(s, { hop, caseHint, createdBy: "single" })
      if (r.isNew || r.merged.length) await branch(r.caseId)
    }
  }

  const investigate = async (entity: EntityRef, fromCaseId: number, hop: number) => {
    const parent = board.resolveCase(fromCaseId)
    const caseId = board.createBranchCase(parent, entity, hop, "single")
    const claim = board.claimEntity(entity, entity.type === "payer" ? "patterns" : "network", caseId)
    if (!claim.claimed) {
      board.mergeCases([claim.ownerCaseId, caseId, parent])
      return
    }
    const root = board.getCase(caseId)?.root_payment_id
    const { from, to } = windowAround(getPayment(root ?? "")?.date ?? "2025-06-30", CONFIG.investigation.windowDays)
    if (entity.type === "payer") {
      const r = investigatePayer(entity.id, from, to)
      await attach(r.signals, hop, caseId)
      board.addFinding({ agent: "patterns", caseId: board.resolveCase(caseId), entity, summary: `Examined ${r.examined} payments of ${entity.name ?? entity.id}.`, paymentIds: [], facts: [] })
      for (const lead of r.leads) {
        const key = `recipient:${lead.recipientId}`
        if (hop + 1 <= CONFIG.investigation.maxHops && !flagged.has(key)) {
          flagged.add(key)
          await investigate({ type: "recipient", id: lead.recipientId, name: lead.recipientName }, board.resolveCase(caseId), hop + 1)
        }
      }
    } else {
      const r = await investigateRecipient(entity.id, from, to)
      await attach(r.signals, hop, caseId)
      const facts: Fact[] = r.record ? [{ kind: "registry", recipientId: r.record.id, foundedOn: r.record.foundedOn, activityCode: r.record.activityCode, activity: r.record.activity, sourceUrl: r.record.sourceUrl }] : []
      board.addFinding({ agent: "network", caseId: board.resolveCase(caseId), entity, summary: `${r.profile.recipientName}: ${r.profile.payments} payments from ${r.profile.payers} institution(s).`, paymentIds: [], facts })
    }
    board.closeBranch(board.resolveCase(caseId))
  }

  const branch = async (caseId: number) => {
    for (const b of await decideBranches(board, caseId, (k) => flagged.has(k), decided)) {
      const key = `${b.entity.type}:${b.entity.id}`
      if (flagged.has(key)) continue
      flagged.add(key)
      await investigate(b.entity, board.resolveCase(caseId), b.hop)
    }
  }

  const ids = listPaymentIds(filter)
  emit<RunStarted>(solo, EV.runStarted, { runId, mode: "single", payments: ids.length, llm: llmEnabled(), web: webMode() })
  const started = Date.now()
  try {
    // 1. Screen every payment, one check after another.
    for (const id of ids) {
      emit<ContractQueued>(solo, EV.contractQueued, { paymentId: id, hop: 0 })
      const p = getPayment(id)!
      const price = await screenPrice(p, reporter)
      if (price.refs.length) board.savePriceRefs(p.id, price.refs)
      await attach(price.signals, 0)
      await attach((await screenProcedure(p)).signals, 0)
      await attach(await screenPatterns(p), 0)
      await attach((await screenRecipient(p)).signals, 0)
    }
    // 2. Score every case, then write and verify dossiers for flagged ones.
    for (const c of board.listCases()) {
      const s = await scoreCase(board, c.id)
      board.setScore(c.id, s.score, s.rationale, s.explanation, board.getCase(c.id)!.revision)
      if (!s.flagged) continue
      const corrections = new Map<string, Fact | null>()
      let proseProblems: string[] = []
      for (let version = 1; version <= CONFIG.investigation.maxRevisions + 1; version++) {
        const d = await writeDossier(board, { caseId: c.id, version, corrections, proseProblems })
        board.saveDossier(c.id, version, d.title, d.bodyMd, d.facts, "draft", null)
        board.setStatus(c.id, "drafted")
        const v = await verifyDossier(board, c.id, d.bodyMd, d.facts)
        if (v.approved) {
          board.setDossierStatus(c.id, version, "approved", v.checks)
          board.setStatus(c.id, "approved")
          break
        }
        board.setDossierStatus(c.id, version, "rejected", { checks: v.checks, rejections: v.rejections })
        proseProblems = rejectionsToCorrections(d.facts, v.rejections, corrections)
      }
    }
    const stats = collectStats(board, runId, "single", ids.length, Date.now() - started, state.counters)
    emit(solo, EV.runSettled, stats)
    board.finishRun(runId, stats)
    return stats
  } finally {
    leave(solo)
    leave(recorder)
  }
}
