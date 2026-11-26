/**
 * Offline (keyword) detection of legitimate explanations in payment
 * descriptions. With an LLM available the agents ask the model instead; this
 * is the deterministic fallback, and also a hint list given to the model.
 */
import type { Payment } from "../domain/types.js"

const EXPLANATION_PATTERNS: Array<{ pattern: RegExp; explanation: string }> = [
  { pattern: /radn[ae] stanic|workstation|precision|rtx|gis/i, explanation: "specialised high-end equipment is stated in the description" },
  { pattern: /zakup|lease|rent|po ugovoru o zakupu/i, explanation: "regular payment under a lease contract" },
  { pattern: /godišnj[ae] zalih|annual stock|godišnja nabavka/i, explanation: "annual stock purchase, a larger amount is expected" },
  { pattern: /hitn|poplav|emergency|flood|havarij/i, explanation: "emergency work, a shortened or negotiated procedure can be legitimate" },
  { pattern: /luksuz|5\*|pet zvezdic|ski škol|ski skol|osiguranj|insurance|praznič|praznic|new year/i, explanation: "the description lists extras (luxury hotel, ski school, insurance, holiday season) that raise the price" },
  { pattern: /inostranstv|abroad|avio|let /i, explanation: "travel abroad or by air is more expensive" },
  { pattern: /pretplat|subscription|licenc|license/i, explanation: "recurring subscription or license fee" },
]

export function findExplanation(payments: Payment[]): string | null {
  for (const p of payments) {
    const text = p.description ?? ""
    for (const { pattern, explanation } of EXPLANATION_PATTERNS) {
      if (pattern.test(text)) return `${explanation} ("${text}")`
    }
  }
  return null
}

export const EXPLANATION_HINTS = EXPLANATION_PATTERNS.map((e) => e.explanation)
