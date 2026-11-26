/**
 * Coordinator: queues payments, owns the case board (attaches signals and
 * findings, merges cases), and decides which entities are worth a branch
 * investigation (rule proposes, LLM confirms).
 */
import type { Agent } from "@mozaik-ai/core"
import { CONFIG } from "../config.js"
import type { EntityRef } from "../domain/types.js"
import { EV, type CaseUpdated, type CasesMerged, type ContractQueued, type EntityClaimed, type EntityFlagged, type FindingReported, type SignalRaised } from "../runtime/events.js"
import { emit, react, runtimeState, sleep, tracked } from "../runtime/runtime.js"
import { decideBranches } from "../skills/branch-skill.js"
import { makeAgent } from "./common.js"

export interface CoordinatorHandle {
  agent: Agent
  /** Queue payments for screening (with back-pressure); resolves when all are queued. */
  queue(paymentIds: string[]): Promise<void>
}

export function createCoordinator(): CoordinatorHandle {
  const state = runtimeState()
  const board = state.requireBoard()
  const flagged = new Set<string>()
  const decided = new Set<string>()
  let self: Agent

  const publishCase = (caseId: number, created: boolean, extra: Partial<CaseUpdated> = {}) => {
    const c = board.getCase(caseId)
    emit<CaseUpdated>(self, EV.caseUpdated, { caseId, created, revision: c?.revision ?? 0, ...extra })
  }
  const publishMerge = (survivor: number, merged: number[], reason: string) => {
    if (merged.length) emit<CasesMerged>(self, EV.casesMerged, { survivor, merged, reason })
  }

  /**
   * Open a branch investigation on an entity: a new line on the case board.
   * The same entity may be flagged from different cases; the agents' claims
   * then make sure it is investigated only once, and the lines are merged.
   */
  const flag = (entity: EntityRef, fromCaseId: number, hop: number, reason: string, branchedBy: "rule" | "llm") => {
    if (hop > CONFIG.investigation.maxHops) return
    const parent = board.resolveCase(fromCaseId)
    const key = `${entity.type}:${entity.id}@${parent}`
    if (flagged.has(key)) return
    flagged.add(key)
    const branchCase = board.createBranchCase(parent, entity, hop, "coordinator")
    emit<EntityFlagged>(self, EV.entityFlagged, { entity, caseId: branchCase, parentCaseId: parent, hop, reason, branchedBy })
  }
  const considerBranch = async (caseId: number) => {
    const isFlagged = (entityKey: string) => flagged.has(`${entityKey}@${board.resolveCase(caseId)}`)
    for (const b of await decideBranches(board, caseId, isFlagged, decided)) flag(b.entity, caseId, b.hop, b.reason, b.via)
  }

  self = makeAgent(
    "coordinator",
    "Coordinates the investigation: queues payments, owns the case board, merges cases, decides where to branch.",
    [],
    [
      react<SignalRaised>([EV.signalRaised], async ({ signal, caseHint, hop }, event) => {
        const producerRole = state.roles.get(event.producerId) ?? signal.agent
        const before = caseHint !== undefined ? board.getCase(board.resolveCase(caseHint))?.title : undefined
        const r = board.attachSignal(signal, { caseHint, hop, createdBy: producerRole })
        publishMerge(
          r.caseId,
          r.merged,
          before
            ? `investigation "${before}" found ${signal.code} on payments already in another line of investigation`
            : `the same payments appear in both cases (${signal.code})`,
        )
        if (r.isNew || r.merged.length) {
          publishCase(r.caseId, r.created, { signalCode: signal.code, signalKey: signal.key })
          await tracked([`case:${r.caseId}`], () => considerBranch(r.caseId))
        }
      }),
      react<FindingReported>([EV.findingReported], async ({ finding, hop, leads }) => {
        const r = board.addFinding(finding)
        publishMerge(r.caseId, r.merged, `finding on ${finding.entity.name ?? finding.entity.id} concerns payments already in another case`)
        for (const lead of leads ?? []) flag(lead.entity, r.caseId, hop + 1, lead.reason, "rule")
        // A branch that produced no signals of its own is folded back into the case it came from.
        const closedInto = board.closeBranch(r.caseId)
        publishCase(closedInto ?? r.caseId, false, { findingAgent: finding.agent })
      }),
      react<EntityClaimed>([EV.entityClaimed], async ({ claimed, caseId, ownerCaseId, entity, agent }) => {
        // Two investigations reached the same entity: the second does no duplicate work and joins the first.
        if (claimed || board.resolveCase(caseId) === board.resolveCase(ownerCaseId)) return
        const branch = board.getCase(caseId)
        const [survivor, merged] = board.mergeCases([ownerCaseId, caseId, ...(branch?.parent_id ? [branch.parent_id] : [])])
        publishMerge(survivor, merged, `two investigations reached ${entity.name ?? entity.id} (${agent} claim already held by case #${ownerCaseId})`)
        publishCase(survivor, false)
      }),
    ],
  )

  return {
    agent: self,
    async queue(paymentIds: string[]) {
      await tracked(["coordinator:feed"], async () => {
        for (const paymentId of paymentIds) {
          while (state.countInflight("payment:") >= CONFIG.investigation.maxPaymentsInFlight * 4) await sleep(2)
          emit<ContractQueued>(self, EV.contractQueued, { paymentId, hop: 0 })
          // Fan-out does not await handlers; yield so they start (and register their work) before the next payment.
          await new Promise((r) => setImmediate(r))
        }
      })
    },
  }
}
