/**
 * Risk assessment, Dossier writer and Verifier.
 *
 * - Risk scores a case once it has been quiet for a moment (no screening or
 *   branch work in flight that touches it), and re-scores it when it changes.
 * - The writer drafts a dossier for every flagged case.
 * - The Verifier recomputes every fact and checks the prose; a rejected claim
 *   goes back to the writer with a correction, so the dossier is fixed.
 */
import type { Agent } from "@mozaik-ai/core"
import { CONFIG } from "../config.js"
import type { Fact } from "../domain/types.js"
import {
  EV,
  type CaseScored,
  type CaseUpdated,
  type CasesMerged,
  type ClaimRejected,
  type DossierApproved,
  type DossierDrafted,
  type PricesExtracted,
  type PricesVerified,
} from "../runtime/events.js"
import { emit, react, runtimeState, tracked } from "../runtime/runtime.js"
import { rejectionsToCorrections, writeDossier } from "../skills/dossier-skill.js"
import { scoreCase } from "../skills/risk-skill.js"
import { verifyDossier, verifyPriceRefs } from "../skills/verify-skill.js"
import { makeAgent } from "./common.js"

/** Keys of in-flight work that would still change a case. */
function caseWorkKeys(caseId: number): string[] {
  const board = runtimeState().requireBoard()
  const ids = board.mergedFamily(caseId)
  const keys = ids.map((id) => `case:${id}`)
  for (const pid of board.casePaymentIds(caseId)) keys.push(`payment:${pid}`)
  for (const e of board.caseEntities(caseId)) keys.push(`entity:${e.type}:${e.id}`)
  return keys
}

// -----------------------------------------------------------------------------
// Risk assessment
// -----------------------------------------------------------------------------
export function createRiskAgent(): Agent {
  const state = runtimeState()
  const timers = new Map<number, NodeJS.Timeout>()
  let self: Agent

  const schedule = (caseId: number) => {
    const existing = timers.get(caseId)
    if (existing) clearTimeout(existing)
    else state.begin([`timer:risk:${caseId}`])
    timers.set(
      caseId,
      setTimeout(() => {
        timers.delete(caseId)
        void run(caseId).finally(() => state.end([`timer:risk:${caseId}`]))
      }, CONFIG.investigation.caseQuietMs),
    )
  }

  const run = async (caseId: number): Promise<void> => {
    const board = state.requireBoard()
    const c = board.getCase(caseId)
    if (!c || c.status === "merged") return
    if (state.isBusy(caseWorkKeys(caseId))) {
      // Still being worked on; check again later (the timer keeps the run alive).
      state.begin([`timer:risk:${caseId}`])
      timers.set(caseId, setTimeout(() => {
        timers.delete(caseId)
        void run(caseId).finally(() => state.end([`timer:risk:${caseId}`]))
      }, CONFIG.investigation.caseQuietMs))
      return
    }
    if (c.scored_revision === c.revision) return
    await tracked([`case:${caseId}:risk`], async () => {
      const revision = c.revision
      const s = await scoreCase(board, caseId)
      board.setScore(caseId, s.score, s.rationale, s.explanation, revision)
      emit<CaseScored>(self, EV.caseScored, { caseId, score: s.score, rationale: s.rationale, explanation: s.explanation, revision, flagged: s.flagged })
    })
  }

  self = makeAgent("risk", "Combines the signals of a case into a risk score and looks for legitimate explanations.", [], [
    react<CaseUpdated>([EV.caseUpdated], ({ caseId }) => schedule(caseId)),
    react<CasesMerged>([EV.casesMerged], ({ survivor }) => schedule(survivor)),
  ])
  return self
}

// -----------------------------------------------------------------------------
// Dossier writer
// -----------------------------------------------------------------------------
interface WriterCaseState {
  version: number
  revisions: number
  draftedRevision: number
  writing: boolean
  again: boolean
  corrections: Map<string, Fact | null>
  proseProblems: string[]
  lastFacts: Fact[]
}

export function createWriterAgent(): Agent {
  const state = runtimeState()
  const cases = new Map<number, WriterCaseState>()
  let self: Agent

  const get = (caseId: number): WriterCaseState => {
    let s = cases.get(caseId)
    if (!s) {
      s = { version: 0, revisions: 0, draftedRevision: -1, writing: false, again: false, corrections: new Map(), proseProblems: [], lastFacts: [] }
      cases.set(caseId, s)
    }
    return s
  }

  const draft = async (caseId: number): Promise<void> => {
    const s = get(caseId)
    if (s.writing) {
      s.again = true
      return
    }
    s.writing = true
    try {
      await tracked([`case:${caseId}:writer`], async () => {
        const board = state.requireBoard()
        s.version++
        const d = await writeDossier(board, { caseId, version: s.version, corrections: s.corrections, proseProblems: s.proseProblems })
        s.lastFacts = d.facts
        s.draftedRevision = board.getCase(caseId)?.scored_revision ?? s.draftedRevision
        board.saveDossier(caseId, s.version, d.title, d.bodyMd, d.facts, "draft", null)
        board.setStatus(caseId, "drafted")
        emit<DossierDrafted>(self, EV.dossierDrafted, { caseId, version: s.version, title: d.title, facts: d.facts })
      })
    } finally {
      s.writing = false
      if (s.again) {
        s.again = false
        void draft(caseId)
      }
    }
  }

  self = makeAgent("writer", "Writes the case dossier in plain language, citing only verified facts and source records.", [], [
    react<CaseScored>([EV.caseScored], ({ caseId, flagged, revision }) => {
      const s = get(caseId)
      if (!flagged || revision <= s.draftedRevision) return
      s.revisions = 0
      return draft(caseId)
    }),
    react<ClaimRejected>([EV.claimRejected], ({ caseId, rejections }) => {
      const s = get(caseId)
      s.proseProblems = rejectionsToCorrections(s.lastFacts, rejections, s.corrections)
      if (s.revisions >= CONFIG.investigation.maxRevisions) {
        state.requireBoard().addNote("writer", null, `Case ${caseId}: revision limit reached; dossier left for human review.`)
        return
      }
      s.revisions++
      return draft(caseId)
    }),
  ])
  return self
}

// -----------------------------------------------------------------------------
// Verifier
// -----------------------------------------------------------------------------
export function createVerifierAgent(): Agent {
  const state = runtimeState()
  let self: Agent
  self = makeAgent("verifier", "Checks every number against the source records and every market price against its page.", [], [
    react<PricesExtracted>([EV.pricesExtracted], ({ requestId, paymentId, refs }) => {
      emit<PricesVerified>(self, EV.pricesVerified, { requestId, paymentId, refs: verifyPriceRefs(refs) })
    }),
    react<DossierDrafted>([EV.dossierDrafted], ({ caseId, version, facts }) =>
      tracked([`case:${caseId}:verifier`], async () => {
        const board = state.requireBoard()
        const d = board.dossiers(caseId).find((x) => x.version === version)
        if (!d) return
        const v = await verifyDossier(board, caseId, d.body_md, facts)
        if (v.approved) {
          board.setDossierStatus(caseId, version, "approved", v.checks)
          board.setStatus(caseId, "approved")
          emit<DossierApproved>(self, EV.dossierApproved, { caseId, version })
        } else {
          board.setDossierStatus(caseId, version, "rejected", { checks: v.checks, rejections: v.rejections })
          emit<ClaimRejected>(self, EV.claimRejected, { caseId, version, rejections: v.rejections })
        }
      }),
    ),
  ])
  return self
}
