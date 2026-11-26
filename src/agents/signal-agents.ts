/**
 * The four signal agents. Each reacts to `contract.queued` at the same time
 * as the others and checks the same payment from its own angle. The network
 * and patterns agents also take branch investigations (`entity.flagged`),
 * claiming the entity first so two investigations never duplicate work.
 */
import type { Agent } from "@mozaik-ai/core"
import { CONFIG } from "../config.js"
import { getPayment } from "../db/source.js"
import type { AgentRole, EntityRef, PriceReference, SignalDraft } from "../domain/types.js"
import {
  EV,
  type AgentNote,
  type ContractQueued,
  type EntityClaimed,
  type EntityFlagged,
  type FindingReported,
  type PaymentScreened,
  type PriceOffer,
  type PriceSearch,
  type PricesExtracted,
  type PricesVerified,
  type SignalRaised,
} from "../runtime/events.js"
import { emit, react, runtimeState, tracked } from "../runtime/runtime.js"
import { investigateRecipient, screenRecipient } from "../skills/network-skill.js"
import { investigatePayer, screenPatterns } from "../skills/patterns-skill.js"
import { screenPrice } from "../skills/price-skill.js"
import { screenProcedure } from "../skills/procedure-skill.js"
import type { Reporter } from "../skills/reporter.js"
import { formatRsd, round } from "../signals/stats.js"
import { TOOLS } from "../tools/tools.js"
import { makeAgent, windowAround } from "./common.js"

function raise(self: Agent, signals: SignalDraft[], hop: number, caseHint?: number): void {
  for (const signal of signals) emit<SignalRaised>(self, EV.signalRaised, { signal, hop, caseHint })
}

/** Screen one queued payment with `check`, marking the payment as in flight meanwhile. */
function onQueued(role: AgentRole, getSelf: () => Agent, check: (paymentId: string, q: ContractQueued) => Promise<SignalDraft[] | null>) {
  return react<ContractQueued>([EV.contractQueued], (q) =>
    tracked([`payment:${q.paymentId}`], async () => {
      const t0 = Date.now()
      const signals = await check(q.paymentId, q)
      if (signals === null) return // not applicable to this source
      raise(getSelf(), signals, q.hop, q.caseId)
      emit<PaymentScreened>(getSelf(), EV.paymentScreened, { paymentId: q.paymentId, agent: role, signals: signals.length, ms: Date.now() - t0 })
    }),
  )
}

// -----------------------------------------------------------------------------
// Price agent
// -----------------------------------------------------------------------------
export function createPriceAgent(): Agent {
  let self: Agent
  const pending = new Map<string, (refs: PriceReference[]) => void>()
  let seq = 0

  const reporter: Reporter = {
    note: (text, ref) => emit<AgentNote>(self, EV.agentNote, { agent: "price", text, ...ref }),
    search: (paymentId, queries, understanding) => emit<PriceSearch>(self, EV.priceSearch, { paymentId, queries, understanding }),
    offer: (paymentId, ref) => emit<PriceOffer>(self, EV.priceOffer, { paymentId, ref }),
    verifyPrices: (paymentId, refs) =>
      new Promise<PriceReference[]>((resolve) => {
        const requestId = `prices-${++seq}`
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve(refs.map((r) => ({ ...r, verified: false, verifyNote: "verification timed out" })))
        }, 30_000)
        pending.set(requestId, (verified) => {
          clearTimeout(timer)
          resolve(verified)
        })
        emit<PricesExtracted>(self, EV.pricesExtracted, { requestId, paymentId, refs })
      }),
  }

  self = makeAgent(
    "price",
    "Finds comparable prices (other institutions, internet offers) and lets a rule decide whether a price is unusual.",
    [TOOLS.webSearch, TOOLS.fetchPage, TOOLS.peerPrices, TOOLS.procurementContext],
    [
      onQueued("price", () => self, async (paymentId) => {
        const p = getPayment(paymentId)!
        const { signals, refs } = await screenPrice(p, reporter)
        if (refs.length) runtimeState().requireBoard().savePriceRefs(p.id, refs)
        return signals
      }),
      react<PricesVerified>([EV.pricesVerified], ({ requestId, refs }) => {
        pending.get(requestId)?.(refs)
        pending.delete(requestId)
      }),
    ],
  )
  return self
}

// -----------------------------------------------------------------------------
// Procurement procedure agent (pure code)
// -----------------------------------------------------------------------------
export function createProcedureAgent(): Agent {
  let self: Agent
  self = makeAgent(
    "procedure",
    "Checks procurement procedures for OCP red flags: single bids, short tender periods, identical or near-identical bids, amendments.",
    [TOOLS.procurementContext],
    [
      onQueued("procedure", () => self, async (paymentId) => {
        const r = await screenProcedure(getPayment(paymentId)!)
        return r.skipped ? null : r.signals
      }),
    ],
  )
  return self
}

// -----------------------------------------------------------------------------
// Institution patterns agent
// -----------------------------------------------------------------------------
export function createPatternsAgent(): Agent {
  let self: Agent
  const board = () => runtimeState().requireBoard()
  self = makeAgent(
    "patterns",
    "Looks at how an institution spends: split payments, year-end spikes, repeated works, budget overruns, vague purposes.",
    [TOOLS.paymentsByPayer],
    [
      onQueued("patterns", () => self, async (paymentId, q) => screenPatterns(getPayment(paymentId)!, q.caseId)),
      react<EntityFlagged>([EV.entityFlagged], async ({ entity, caseId, hop }) => {
        if (entity.type !== "payer") return
        await tracked([`entity:payer:${entity.id}`, `case:${caseId}`], async () => {
          const claim = board().claimEntity(entity, "patterns", caseId)
          emit<EntityClaimed>(self, EV.entityClaimed, { entity, agent: "patterns", caseId, claimed: claim.claimed, ownerCaseId: claim.ownerCaseId })
          if (!claim.claimed) return
          const root = board().getCase(caseId)?.root_payment_id
          const { from, to } = windowAround(getPayment(root ?? "")?.date ?? "2025-06-30", CONFIG.investigation.windowDays)
          const { signals, leads, examined } = investigatePayer(entity.id, from, to)
          raise(self, signals, hop, caseId)
          const leadRefs: EntityRef[] = leads.map((l) => ({ type: "recipient", id: l.recipientId, name: l.recipientName }))
          emit<FindingReported>(self, EV.findingReported, {
            finding: {
              agent: "patterns",
              caseId,
              entity,
              summary: `Examined ${examined} payments of ${entity.name ?? entity.id} (${from} to ${to}): ${signals.length} pattern signal(s)${leads.length ? `; dominant recipients: ${leads.map((l) => `${l.recipientName} (${round(l.share * 100)}% of ${l.count} ${l.group.replace("_", " ")} payments)`).join(", ")}` : ""}.`,
              paymentIds: [],
              facts: [],
            },
            hop,
            leads: leadRefs.map((e, i) => ({ entity: e, reason: `dominant recipient of ${leads[i].group.replace("_", " ")} at ${entity.name ?? entity.id}` })),
          })
        })
      }),
    ],
  )
  return self
}

// -----------------------------------------------------------------------------
// Recipient network agent
// -----------------------------------------------------------------------------
export function createNetworkAgent(): Agent {
  let self: Agent
  const board = () => runtimeState().requireBoard()
  self = makeAgent(
    "network",
    "Looks at who is paid: business-register data, recipients that dominate a payer, recipients that are new or do unrelated business.",
    [TOOLS.registryLookup, TOOLS.paymentsByRecipient, TOOLS.webSearch],
    [
      onQueued("network", () => self, async (paymentId, q) => (await screenRecipient(getPayment(paymentId)!, q.caseId)).signals),
      react<EntityFlagged>([EV.entityFlagged], async ({ entity, caseId, hop }) => {
        if (entity.type !== "recipient") return
        await tracked([`entity:recipient:${entity.id}`, `case:${caseId}`], async () => {
          const claim = board().claimEntity(entity, "network", caseId)
          emit<EntityClaimed>(self, EV.entityClaimed, { entity, agent: "network", caseId, claimed: claim.claimed, ownerCaseId: claim.ownerCaseId })
          if (!claim.claimed) return
          const root = board().getCase(caseId)?.root_payment_id
          const { from, to } = windowAround(getPayment(root ?? "")?.date ?? "2025-06-30", CONFIG.investigation.windowDays)
          const { profile, signals, record } = await investigateRecipient(entity.id, from, to)
          raise(self, signals, hop, caseId)
          const top = profile.byPayerGroup.slice(0, 3).map((g) => `${g.payerName}: ${g.count} ${g.group.replace("_", " ")}`).join("; ")
          emit<FindingReported>(self, EV.findingReported, {
            finding: {
              agent: "network",
              caseId,
              entity: { ...entity, name: profile.recipientName },
              summary: `${profile.recipientName} received ${profile.payments} payments (${formatRsd(profile.total)}) from ${profile.payers} institution(s) in the window${top ? ` - largest: ${top}` : ""}.${record ? ` Registered ${record.foundedOn}, activity ${record.activityCode} ${record.activity}.` : " Not found in the business register."}`,
              paymentIds: [],
              facts: record ? [{ kind: "registry", recipientId: record.id, foundedOn: record.foundedOn, activityCode: record.activityCode, activity: record.activity, sourceUrl: record.sourceUrl }] : [],
            },
            hop,
          })
        })
      }),
    ],
  )
  return self
}
