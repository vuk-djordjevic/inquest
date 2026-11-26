/**
 * Recipient-network agent skill: who is being paid. Looks the recipient up in
 * the business register (registration date, registered activity), checks it
 * against what it was paid for, and - when an investigation branches to a
 * recipient - maps where all of its public money comes from.
 */
import { REFERENCE } from "../config.js"
import type { Payment, RegistryRecord, SignalDraft } from "../domain/types.js"
import { LANGUAGE_RULES, bool, obj, str, think } from "../llm/think.js"
import { activityMismatchCandidate, investigateRecipientNetwork, newRecipientSignal, unusualRecipientSignal, type RecipientProfile } from "../signals/network.js"
import { formatRsd } from "../signals/stats.js"
import { TOOLS } from "../tools/tools.js"

const registryMemo = new Map<string, Promise<RegistryRecord | null>>()
export function resetRegistryMemo(): void {
  registryMemo.clear()
}

export function lookupRecipient(recipientId: string): Promise<RegistryRecord | null> {
  let r = registryMemo.get(recipientId)
  if (!r) {
    r = TOOLS.registryLookup.invoke({ recipientId })
    registryMemo.set(recipientId, r)
  }
  return r
}

export async function screenRecipient(p: Payment, caseId?: number): Promise<{ signals: SignalDraft[]; record: RegistryRecord | null }> {
  if (p.status !== "completed") return { signals: [], record: null }
  const record = await lookupRecipient(p.recipient_id)
  if (!record) return { signals: [], record: null }
  const signals: SignalDraft[] = []
  const fresh = newRecipientSignal(p, record)
  if (fresh) signals.push(fresh)
  if (activityMismatchCandidate(p, record)) {
    const r = await think<{ plausible: boolean; reason: string }>({
      role: "network",
      task: "judge_activity",
      caseId,
      instruction: `You judge whether a company with the given registered activity could plausibly be the normal supplier of what a public institution paid it for. Wholesalers and retailers can supply many goods; a restaurant supplying computers, or a construction firm supplying medical consulting, is not plausible. ${LANGUAGE_RULES}`,
      prompt: JSON.stringify({ company: record.name, registeredActivity: `${record.activityCode} ${record.activity}`, paidFor: REFERENCE.categories[p.category]?.label, description: p.description, amount: formatRsd(p.amount) }),
      schema: obj({ plausible: bool(), reason: str() }),
      offline: () => ({ plausible: false, reason: "" }),
    })
    if (!r.value.plausible) signals.push(unusualRecipientSignal(p, record, r.value.reason))
  }
  return { signals, record }
}

export async function investigateRecipient(recipientId: string, from: string, to: string): Promise<{ profile: RecipientProfile; signals: SignalDraft[]; record: RegistryRecord | null }> {
  const record = await lookupRecipient(recipientId)
  const { profile, signals } = investigateRecipientNetwork(recipientId, from, to)
  return { profile, signals, record }
}
