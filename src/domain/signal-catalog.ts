import type { AgentRole, SignalCode } from "./types.js"

export interface SignalInfo {
  code: SignalCode
  name: string
  /** Open Contracting Partnership red-flag code, where one exists. */
  ocp: string | null
  agent: AgentRole
  layer: "general" | "procurement"
  description: string
}

/**
 * Catalog of the risk signals Inquest computes. General signals work on any
 * public spending; procurement signals need bid/procedure data and follow the
 * OCP red-flag guide (simplified).
 */
export const SIGNALS: Record<SignalCode, SignalInfo> = {
  PEER_PRICE: { code: "PEER_PRICE", name: "Price above comparable institutions", ocp: "R016", agent: "price", layer: "general",
    description: "Unit price outside Q3 + 1.5 x IQR for the same category among institutions of the same kind." },
  MARKET_PRICE: { code: "MARKET_PRICE", name: "Price above market reference", ocp: null, agent: "price", layer: "general",
    description: "Unit price more than twice the median of at least 3 verified market offers found online." },
  WIDE_BID_SPREAD: { code: "WIDE_BID_SPREAD", name: "Wide spread of bid prices", ocp: "R022", agent: "price", layer: "procurement",
    description: "(highest bid - lowest bid) / mean bid is unusually large." },
  SINGLE_BID: { code: "SINGLE_BID", name: "Only one bid", ocp: "R018", agent: "procedure", layer: "procurement",
    description: "Open procedure that received a single bid." },
  SHORT_TENDER: { code: "SHORT_TENDER", name: "Tender period too short", ocp: "R003", agent: "procedure", layer: "procurement",
    description: "Bid deadline minus tender start is below the minimum for the procedure type." },
  IDENTICAL_BIDS: { code: "IDENTICAL_BIDS", name: "Identical bid prices", ocp: "R028", agent: "procedure", layer: "procurement",
    description: "Two bids in the same procedure have exactly the same price." },
  CLOSE_SECOND_BID: { code: "CLOSE_SECOND_BID", name: "Second bid suspiciously close to winner", ocp: "R024", agent: "procedure", layer: "procurement",
    description: "(second lowest - winning) / winning is unusually small." },
  AMENDMENT_INFLATION: { code: "AMENDMENT_INFLATION", name: "Value increased by amendments", ocp: null, agent: "procedure", layer: "procurement",
    description: "Contract value after amendments / original value above the threshold." },
  SPLIT: { code: "SPLIT", name: "Split below approval threshold", ocp: "R011", agent: "patterns", layer: "general",
    description: "Several payments in a short window, each just below the approval or procurement threshold." },
  REPEATED_OBJECT: { code: "REPEATED_OBJECT", name: "Repeated expense for the same object", ocp: null, agent: "patterns", layer: "general",
    description: "The same object (street, building) paid for the same kind of work several times within two years." },
  VAGUE_PURPOSE: { code: "VAGUE_PURPOSE", name: "Expense without a clear purpose", ocp: null, agent: "patterns", layer: "general",
    description: "Description is empty, generic or does not match the category." },
  YEAR_END_SPIKE: { code: "YEAR_END_SPIKE", name: "Year-end spending spike", ocp: null, agent: "patterns", layer: "general",
    description: "December share of the annual spending in a category far above the monthly average." },
  ROUND_REPEATED: { code: "ROUND_REPEATED", name: "Round and repeated amounts", ocp: null, agent: "patterns", layer: "general",
    description: "Unusually many identical round amounts to one recipient." },
  OVER_PLAN: { code: "OVER_PLAN", name: "Paid more than planned", ocp: null, agent: "patterns", layer: "general",
    description: "Sum of payments in a budget line exceeds the planned amount." },
  NONCOMPETITIVE_SHARE: { code: "NONCOMPETITIVE_SHARE", name: "Frequent non-competitive procedures", ocp: "R013", agent: "patterns", layer: "procurement",
    description: "Share of non-competitive procedures of a buyer above 30%." },
  CONCENTRATION: { code: "CONCENTRATION", name: "Concentration on one recipient", ocp: null, agent: "network", layer: "general",
    description: "One recipient receives most of a payer's spending in a category group." },
  NEW_RECIPIENT: { code: "NEW_RECIPIENT", name: "Newly founded recipient", ocp: null, agent: "network", layer: "general",
    description: "Recipient founded shortly before its first payment." },
  UNUSUAL_RECIPIENT: { code: "UNUSUAL_RECIPIENT", name: "Recipient activity does not match", ocp: null, agent: "network", layer: "general",
    description: "Registered activity of the recipient does not fit what it was paid for." },
}

/** Words the system must never use about a concrete entity (see ethics section of the spec). */
export const BANNED_WORDS = [
  "corruption", "corrupt", "fraud", "fraudulent", "theft", "steal", "stole", "embezzle", "bribe", "kickback", "criminal",
  "korupcij", "prevar", "krađ", "kradj", "pronever", "mito", "kriminal",
]
