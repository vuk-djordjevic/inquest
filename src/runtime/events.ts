/**
 * Inquest event vocabulary. Every coordination step between agents is one of
 * these Mozaik events; the dashboard and the run log are just observers.
 */
import type { AgentRole, EntityRef, Fact, Finding, PriceReference, SignalDraft } from "../domain/types.js"

export const EV = {
  runStarted: "run.started",
  runSettled: "run.settled",
  contractQueued: "contract.queued",
  paymentScreened: "payment.screened",
  signalRaised: "signal.raised",
  caseUpdated: "case.updated",
  entityFlagged: "entity.flagged",
  entityClaimed: "entity.claimed",
  findingReported: "finding.reported",
  casesMerged: "cases.merged",
  caseScored: "case.scored",
  priceSearch: "price.search",
  priceOffer: "price.offer",
  pricesExtracted: "prices.extracted",
  pricesVerified: "prices.verified",
  dossierDrafted: "dossier.drafted",
  claimRejected: "claim.rejected",
  dossierApproved: "dossier.approved",
  agentNote: "agent.note",
  agentError: "agent.error",
} as const

export interface RunStarted { runId: string; mode: "team" | "single"; payments: number; llm: boolean; web: string }
export interface ContractQueued { paymentId: string; hop: number; caseId?: number; reason?: string }
export interface PaymentScreened { paymentId: string; agent: AgentRole; signals: number; ms: number }
export interface SignalRaised { signal: SignalDraft; caseHint?: number; hop: number }
export interface CaseUpdated { caseId: number; created: boolean; signalCode?: string; signalKey?: string; findingAgent?: AgentRole; revision: number }
/** caseId is the new branch case; parentCaseId the case the branch came from. */
export interface EntityFlagged { entity: EntityRef; caseId: number; parentCaseId: number; hop: number; reason: string; branchedBy: "rule" | "llm" }
export interface EntityClaimed { entity: EntityRef; agent: AgentRole; caseId: number; claimed: boolean; ownerCaseId: number }
export interface FindingReported { finding: Finding; hop: number; leads?: Array<{ entity: EntityRef; reason: string }> }
export interface CasesMerged { survivor: number; merged: number[]; reason: string }
export interface CaseScored { caseId: number; score: number; rationale: string; explanation: string | null; revision: number; flagged: boolean }
export interface PriceSearch { paymentId: string; queries: string[]; understanding: string }
export interface PriceOffer { paymentId: string; ref: PriceReference }
export interface PricesExtracted { requestId: string; paymentId: string; refs: PriceReference[] }
export interface PricesVerified { requestId: string; paymentId: string; refs: PriceReference[] }
export interface DossierDrafted { caseId: number; version: number; title: string; facts: Fact[] }
export interface Rejection { factIndex: number | null; reason: string; corrected?: Fact }
export interface ClaimRejected { caseId: number; version: number; rejections: Rejection[] }
export interface DossierApproved { caseId: number; version: number }
export interface AgentNote { agent: AgentRole; paymentId?: string; caseId?: number; text: string }
