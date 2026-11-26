import type { PriceReference } from "../domain/types.js"

/**
 * How a skill talks to the outside world while it works. In the team run this
 * publishes Mozaik events (and price verification is a request to the
 * Verifier agent); in the single-agent baseline it calls things directly.
 */
export interface Reporter {
  note(text: string, ref?: { paymentId?: string; caseId?: number }): void
  search(paymentId: string, queries: string[], understanding: string): void
  offer(paymentId: string, ref: PriceReference): void
  verifyPrices(paymentId: string, refs: PriceReference[]): Promise<PriceReference[]>
}
