import assert from "node:assert/strict"
import { test } from "node:test"
import type { Payment, PriceReference, ProcurementContext } from "../src/domain/types.js"
import { marketDecision } from "../src/signals/price.js"
import { amendmentSignal, closeSecondBidSignal, identicalBidsSignal, shortTenderSignal, singleBidSignal } from "../src/signals/procedure.js"
import { tukeyFences } from "../src/signals/stats.js"

const payment: Payment = {
  id: "P1", payer_id: "MU99", payer_name: "Test", payer_kind: "school", recipient_id: "R1", recipient_name: "Firm",
  amount: 4_219_200, currency: "RSD", date: "2025-05-12", category: "excursion", description: "Ekskurzija Kopaonik, 2 dana, 45 učenika",
  quantity: 90, unit: "student_day", object_ref: null, source: "school", source_ref: "x", status: "completed", dataset: "synthetic",
}
const ctx = (over: Partial<ProcurementContext>): ProcurementContext => ({
  payment_id: "P1", ocid: null, procedure_type: "open", procedure_details: null, contract_kind: "goods", estimated_value: null,
  tender_start: "2025-01-01", tender_end: "2025-02-15", bids_count: 3, bids: [], original_value: null, final_value: null, amendments: [], ...over,
})
const bids = (...amounts: number[]) => amounts.map((amount, i) => ({ bidderId: `B${i}`, bidderName: `B${i}`, amount }))

test("Tukey fences", () => {
  const f = tukeyFences([1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(f.median, 4.5)
  assert.equal(f.q1, 2.75)
  assert.equal(f.q3, 6.25)
  assert.equal(f.upper, 6.25 + 1.5 * 3.5)
})

test("procedure red flags", () => {
  assert.ok(singleBidSignal(payment, ctx({ bids_count: 1 })))
  assert.equal(singleBidSignal(payment, ctx({ bids_count: 1, procedure_type: "limited" })), null)
  assert.equal(shortTenderSignal(payment, ctx({ tender_end: "2025-01-04" }))?.facts[0].kind, "tender_days")
  assert.equal(shortTenderSignal(payment, ctx({})), null)
  assert.ok(identicalBidsSignal(payment, ctx({ bids: bids(100, 120, 120) })))
  assert.equal(identicalBidsSignal(payment, ctx({ bids: bids(100, 120, 130) })), null)
  assert.ok(closeSecondBidSignal(payment, ctx({ bids: bids(6_120_000, 6_122_000) })))
  assert.equal(closeSecondBidSignal(payment, ctx({ bids: bids(100, 110) })), null)
  assert.ok(amendmentSignal(payment, ctx({ original_value: 10, final_value: 16, amendments: [{}] })))
  assert.equal(amendmentSignal(payment, ctx({ original_value: 10, final_value: 11, amendments: [{}] })), null)
})

test("market rule: at least 3 verified comparables, signal above 2x the median", () => {
  const ref = (rsd: number, verified = true): PriceReference => ({ url: "u", title: "t", price: rsd, currency: "RSD", normalizedRsd: rsd, includes: "", quote: "q", verified })
  assert.equal(marketDecision(payment, [ref(9000), ref(10000)]).outcome, "insufficient_data")
  assert.equal(marketDecision(payment, [ref(9000), ref(10000), ref(11000, false)]).outcome, "insufficient_data")
  const d = marketDecision(payment, [ref(9000), ref(10000), ref(11000)])
  assert.equal(d.outcome, "signal") // 46,880 RSD per student-day vs median 10,000
  assert.equal(marketDecision({ ...payment, amount: 90 * 15000 }, [ref(9000), ref(10000), ref(11000)]).outcome, "within_range")
})
