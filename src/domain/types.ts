/**
 * Domain types of the common payment model and of the investigation.
 * Agents never see source-specific formats, only these shapes.
 */

export interface Payment {
  id: string
  payer_id: string
  payer_name: string
  payer_kind: string
  recipient_id: string
  recipient_name: string
  amount: number
  currency: string
  date: string
  category: string
  description: string | null
  quantity: number | null
  unit: string | null
  object_ref: string | null
  source: string
  source_ref: string
  status: "completed" | "cancelled"
  dataset: "synthetic" | "real"
}

export interface Bid {
  bidderId: string
  bidderName: string
  amount: number | null
}

export interface ProcurementContext {
  payment_id: string
  ocid: string | null
  procedure_type: string | null
  procedure_details: string | null
  contract_kind: string | null
  estimated_value: number | null
  tender_start: string | null
  tender_end: string | null
  bids_count: number | null
  bids: Bid[]
  original_value: number | null
  final_value: number | null
  amendments: Array<{ id?: string; date?: string; rationale?: string; description?: string }>
}

export type SignalCode =
  | "PEER_PRICE"
  | "MARKET_PRICE"
  | "WIDE_BID_SPREAD"
  | "SINGLE_BID"
  | "SHORT_TENDER"
  | "IDENTICAL_BIDS"
  | "CLOSE_SECOND_BID"
  | "AMENDMENT_INFLATION"
  | "SPLIT"
  | "REPEATED_OBJECT"
  | "VAGUE_PURPOSE"
  | "YEAR_END_SPIKE"
  | "ROUND_REPEATED"
  | "OVER_PLAN"
  | "NONCOMPETITIVE_SHARE"
  | "CONCENTRATION"
  | "NEW_RECIPIENT"
  | "UNUSUAL_RECIPIENT"

export type AgentRole = "coordinator" | "price" | "procedure" | "patterns" | "network" | "risk" | "writer" | "verifier"

export type EntityType = "payer" | "recipient"

export interface EntityRef {
  type: EntityType
  id: string
  name?: string
}

/**
 * A checkable statement of fact. Agents attach facts to signals; the dossier
 * may only state numbers that appear in facts; the Verifier recomputes every
 * fact from the source records with its own (strict) rules.
 */
export type Fact =
  | { kind: "payment_amount"; paymentId: string; amount: number }
  | { kind: "unit_price"; paymentId: string; unitPrice: number; unit: string }
  | { kind: "peer_median"; category: string; payerKind: string; unit: string; median: number; peers: number }
  | { kind: "payments_in_window"; payerId: string; recipientId: string | null; paymentIds: string[]; count: number; total: number }
  | { kind: "supplier_share"; payerId: string; recipientId: string; group: string; wins: number; total: number; from: string; to: string }
  | { kind: "bids_count"; paymentId: string; bids: number }
  | { kind: "tender_days"; paymentId: string; days: number; minimum: number }
  | { kind: "identical_bids"; paymentId: string; amount: number; count: number }
  | { kind: "bid_gap"; paymentId: string; gapPct: number }
  | { kind: "bid_spread"; paymentId: string; spreadPct: number }
  | { kind: "amendment"; paymentId: string; originalValue: number; finalValue: number }
  | { kind: "plan_vs_spent"; payerId: string; category: string; year: number; planned: number; spent: number }
  | { kind: "december_share"; payerId: string; category: string; year: number; sharePct: number }
  | { kind: "object_repeats"; payerId: string; objectRef: string; category: string; count: number; total: number }
  | { kind: "identical_amounts"; payerId: string; recipientId: string; amount: number; count: number }
  | { kind: "noncompetitive_share"; payerId: string; noncompetitive: number; total: number }
  | { kind: "registry"; recipientId: string; foundedOn: string | null; activityCode: string | null; activity: string | null; sourceUrl: string }
  | { kind: "first_payment_after_founding"; recipientId: string; days: number }
  | { kind: "market_median"; paymentId: string; median: number; comparables: number; unit: string }
  | { kind: "price_ref"; url: string; price: number; currency: string; quote: string }
  | { kind: "description"; paymentId: string; text: string }

export interface SignalDraft {
  code: SignalCode
  agent: AgentRole
  /** 0..1, how strongly this signal alone suggests the case is worth checking. */
  strength: number
  /** Short factual sentence. Never accusatory. */
  summary: string
  /** The rule that fired, in plain words, e.g. "unit price > Q3 + 1.5 x IQR of 42 peers". */
  rule: string
  payerId: string
  recipientId: string | null
  paymentIds: string[]
  facts: Fact[]
  /** Legitimate explanation found by the agent, if any (lowers strength). */
  explanation?: string | null
  /** Dedup key: the same key means the same underlying observation. */
  key: string
}

export interface Signal extends SignalDraft {
  id: number
  caseId: number
  createdAt: string
}

export interface CaseRow {
  id: number
  title: string
  status: "open" | "scored" | "drafted" | "approved" | "merged"
  merged_into: number | null
  priority: number
  score: number | null
  revision: number
  scored_revision: number | null
  root_payment_id: string | null
  parent_id: number | null
  merge_reason: string | null
  hop: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface Finding {
  agent: AgentRole
  caseId: number
  entity: EntityRef
  summary: string
  paymentIds: string[]
  facts: Fact[]
}

export interface PriceReference {
  url: string
  title: string
  price: number
  currency: string
  /** Price converted to RSD per payment unit (e.g. per student-day). */
  normalizedRsd: number
  includes: string
  quote: string
  verified?: boolean
  verifyNote?: string
}

export interface RegistryRecord {
  id: string
  name: string
  foundedOn: string | null
  activityCode: string | null
  activity: string | null
  status: string | null
  sourceUrl: string
}

export interface ClaimCheck {
  factIndex: number
  ok: boolean
  note: string
  corrected?: Fact
}

export interface DossierDraft {
  caseId: number
  version: number
  title: string
  bodyMd: string
  facts: Fact[]
}
