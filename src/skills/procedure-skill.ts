/**
 * Procurement-procedure agent skill (pure code): OCP indicators on bids,
 * tender periods and amendments. Skipped when the source has no procedure data
 * (school or municipal payment ledgers).
 */
import type { Payment, SignalDraft } from "../domain/types.js"
import { PROCEDURE_CHECKS } from "../signals/procedure.js"
import { TOOLS } from "../tools/tools.js"

export async function screenProcedure(p: Payment): Promise<{ skipped: boolean; signals: SignalDraft[] }> {
  if (p.source !== "procurement") return { skipped: true, signals: [] }
  const ctx = await TOOLS.procurementContext.invoke({ paymentId: p.id })
  if (!ctx) return { skipped: true, signals: [] }
  const signals: SignalDraft[] = []
  for (const check of PROCEDURE_CHECKS) {
    const s = check(p, ctx)
    if (s) signals.push(s)
  }
  return { skipped: false, signals }
}
