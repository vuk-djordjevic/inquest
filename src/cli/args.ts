import type { PaymentFilter } from "../db/source.js"

/** Parse --payers A,B --sources x,y --limit N --dataset synthetic|real into a payment filter. */
export function parseFilter(argv = process.argv.slice(2)): PaymentFilter {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined)
  const limit = get("limit")
  const dataset = get("dataset")
  return {
    payerIds: list(get("payers")),
    sources: list(get("sources")),
    limit: limit ? Number(limit) : undefined,
    dataset: dataset === "real" || dataset === "synthetic" ? dataset : undefined,
  }
}

export function isFullRun(f: PaymentFilter): boolean {
  return !f.payerIds && !f.sources && !f.limit && !f.dataset
}
