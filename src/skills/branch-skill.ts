/**
 * Branching decision: is a case strong enough to widen the investigation to
 * its payer and recipients? A rule proposes candidates; the LLM confirms which
 * ones are worth it (offline: all rule candidates).
 */
import { CONFIG } from "../config.js"
import type { CaseBoard } from "../db/board.js"
import { getPayment } from "../db/source.js"
import { SIGNALS } from "../domain/signal-catalog.js"
import type { EntityRef } from "../domain/types.js"
import { arr, bool, obj, str, think } from "../llm/think.js"

export interface BranchDecision {
  entity: EntityRef
  hop: number
  reason: string
  via: "rule" | "llm"
}

/**
 * `isFlagged(entityKey)` tells whether "<type>:<id>" was already branched from this case.
 * The same entity may still be branched from a different case; the agents' claims resolve that.
 */
export async function decideBranches(board: CaseBoard, caseId: number, isFlagged: (entityKey: string) => boolean, decided: Set<string>): Promise<BranchDecision[]> {
  const c = board.getCase(caseId)
  if (!c || c.status === "merged" || c.hop >= CONFIG.investigation.maxHops) return []
  const signals = board.caseSignals(caseId)
  const agents = new Set(signals.map((s) => s.agent))
  const strongest = Math.max(0, ...signals.map((s) => s.strength))
  if (agents.size < 2 && strongest < 0.55) return []

  const candidates: Array<EntityRef & { why: string }> = []
  for (const s of signals) {
    const p = getPayment(s.paymentIds[0])
    if (s.recipientId && !isFlagged(`recipient:${s.recipientId}`)) {
      candidates.push({ type: "recipient", id: s.recipientId, name: p?.recipient_id === s.recipientId ? p.recipient_name : undefined, why: SIGNALS[s.code].name })
    }
    if (!isFlagged(`payer:${s.payerId}`)) candidates.push({ type: "payer", id: s.payerId, name: p?.payer_name, why: SIGNALS[s.code].name })
  }
  const unique = [...new Map(candidates.map((x) => [`${x.type}:${x.id}`, x])).values()].slice(0, 4)
  const key = `${caseId}|${unique.map((u) => u.type + u.id).join(",")}`
  if (!unique.length || decided.has(key)) return []
  decided.add(key)

  const r = await think<{ branches: Array<{ entityType: string; entityId: string; branch: boolean; reason: string }> }>({
    role: "coordinator",
    task: "decide_branches",
    caseId,
    instruction: `You are the Coordinator of a team investigating risk signals in public spending. Given the signals of a case, decide which payers and recipients deserve a wider look at their other payments. Branch when signals converge on an entity or when one strong signal concerns a specific recipient; skip entities only incidentally involved. Investigations are limited to ${CONFIG.investigation.maxHops} hops and a two-year window.`,
    prompt: JSON.stringify({
      signals: signals.map((s) => ({ signal: SIGNALS[s.code].name, strength: s.strength, summary: s.summary })),
      candidates: unique.map((u) => ({ entityType: u.type, entityId: u.id, name: u.name })),
    }),
    schema: obj({ branches: arr(obj({ entityType: str(), entityId: str(), branch: bool(), reason: str() })) }),
    offline: () => ({
      branches: unique.map((u) => ({ entityType: u.type, entityId: u.id, branch: true, reason: `${u.why}; signals from ${agents.size} agent(s) on this case` })),
    }),
  })
  const out: BranchDecision[] = []
  for (const b of r.value.branches) {
    const u = unique.find((x) => x.type === b.entityType && x.id === b.entityId)
    if (u && b.branch) out.push({ entity: { type: u.type, id: u.id, name: u.name }, hop: c.hop + 1, reason: b.reason, via: r.via === "llm" ? "llm" : "rule" })
  }
  return out
}
