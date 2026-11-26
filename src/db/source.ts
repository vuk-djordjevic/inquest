/**
 * Read-only access to the common payment model (built by data/prep/build_all.py).
 * Agents use these queries directly in code (signal formulas) and through
 * Mozaik tools (when an LLM decides what to look at).
 */
import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { CONFIG, categoriesInGroup } from "../config.js"
import type { Bid, Payment, ProcurementContext } from "../domain/types.js"

let db: Database.Database | null = null

export function sourceDb(): Database.Database {
  if (!db) {
    if (!existsSync(CONFIG.dbPath)) {
      throw new Error(`Dataset not found at ${CONFIG.dbPath}. Run "npm run data" first.`)
    }
    db = new Database(CONFIG.dbPath, { readonly: true, fileMustExist: true })
  }
  return db
}

const PAYMENT_COLUMNS = `id, payer_id, payer_name, payer_kind, recipient_id, recipient_name, amount, currency, date,
  category, description, quantity, unit, object_ref, source, source_ref, status, dataset`

const paymentCache = new Map<string, Payment>()

export function getPayment(id: string): Payment | undefined {
  const cached = paymentCache.get(id)
  if (cached) return cached
  const row = sourceDb().prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ?`).get(id) as Payment | undefined
  if (row) paymentCache.set(id, row)
  return row
}

export function getPayments(ids: string[]): Payment[] {
  return ids.map(getPayment).filter((p): p is Payment => Boolean(p))
}

export function getSourceRecord(id: string): { source_ref: string; source_record: string } | undefined {
  return sourceDb().prepare(`SELECT source_ref, source_record FROM payments WHERE id = ?`).get(id) as
    | { source_ref: string; source_record: string }
    | undefined
}

export interface PaymentFilter {
  payerIds?: string[]
  sources?: string[]
  dataset?: "synthetic" | "real"
  limit?: number
}

export function listPaymentIds(filter: PaymentFilter = {}): string[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.payerIds?.length) {
    where.push(`payer_id IN (${filter.payerIds.map(() => "?").join(",")})`)
    params.push(...filter.payerIds)
  }
  if (filter.sources?.length) {
    where.push(`source IN (${filter.sources.map(() => "?").join(",")})`)
    params.push(...filter.sources)
  }
  if (filter.dataset) {
    where.push("dataset = ?")
    params.push(filter.dataset)
  }
  const sql = `SELECT id FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date, id ${
    filter.limit ? "LIMIT " + Number(filter.limit) : ""
  }`
  return (sourceDb().prepare(sql).all(...params) as Array<{ id: string }>).map((r) => r.id)
}

export function paymentsByPayer(payerId: string, opts: { category?: string; group?: string; from?: string; to?: string } = {}): Payment[] {
  const where = ["payer_id = ?"]
  const params: unknown[] = [payerId]
  if (opts.category) {
    where.push("category = ?")
    params.push(opts.category)
  }
  if (opts.group) {
    const cats = categoriesInGroup(opts.group)
    where.push(`category IN (${cats.map(() => "?").join(",")})`)
    params.push(...cats)
  }
  if (opts.from) {
    where.push("date >= ?")
    params.push(opts.from)
  }
  if (opts.to) {
    where.push("date <= ?")
    params.push(opts.to)
  }
  return sourceDb()
    .prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE ${where.join(" AND ")} ORDER BY date`)
    .all(...params) as Payment[]
}

export function paymentsByRecipient(recipientId: string, opts: { from?: string; to?: string } = {}): Payment[] {
  const where = ["recipient_id = ?"]
  const params: unknown[] = [recipientId]
  if (opts.from) {
    where.push("date >= ?")
    params.push(opts.from)
  }
  if (opts.to) {
    where.push("date <= ?")
    params.push(opts.to)
  }
  return sourceDb()
    .prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE ${where.join(" AND ")} ORDER BY date`)
    .all(...params) as Payment[]
}

/** Unit prices of completed payments in a category among payers of the same kind. */
const peerCache = new Map<string, Array<{ id: string; payer_id: string; unit_price: number }>>()
export function peerUnitPrices(category: string, payerKind: string): Array<{ id: string; payer_id: string; unit_price: number }> {
  const key = `${category}|${payerKind}`
  let rows = peerCache.get(key)
  if (!rows) {
    rows = sourceDb()
      .prepare(
        `SELECT id, payer_id, amount / quantity AS unit_price FROM payments
         WHERE category = ? AND payer_kind = ? AND status = 'completed' AND quantity > 0`,
      )
      .all(category, payerKind) as Array<{ id: string; payer_id: string; unit_price: number }>
    peerCache.set(key, rows)
  }
  return rows
}

interface RawContext extends Omit<ProcurementContext, "bids" | "amendments"> {
  bids_json: string | null
  amendments_json: string | null
}

export function getProcurementContext(paymentId: string): ProcurementContext | undefined {
  const row = sourceDb().prepare(`SELECT * FROM procurement_context WHERE payment_id = ?`).get(paymentId) as RawContext | undefined
  if (!row) return undefined
  const { bids_json, amendments_json, ...rest } = row
  return {
    ...rest,
    bids: bids_json ? (JSON.parse(bids_json) as Bid[]) : [],
    amendments: amendments_json ? JSON.parse(amendments_json) : [],
  }
}

export function procedureTypesByPayer(payerId: string): Array<{ payment_id: string; procedure_type: string; status: string }> {
  return sourceDb()
    .prepare(
      `SELECT c.payment_id, c.procedure_type, p.status FROM procurement_context c
       JOIN payments p ON p.id = c.payment_id WHERE p.payer_id = ?`,
    )
    .all(payerId) as Array<{ payment_id: string; procedure_type: string; status: string }>
}

export function getBudgetPlan(payerId: string, category: string, year: number): number | undefined {
  const row = sourceDb()
    .prepare(`SELECT planned_amount FROM budget_plans WHERE payer_id = ? AND category = ? AND year = ?`)
    .get(payerId, category, year) as { planned_amount: number } | undefined
  return row?.planned_amount
}

export function getInstitution(id: string): { id: string; name: string; kind: string; municipality: string; dataset: string } | undefined {
  return sourceDb().prepare(`SELECT * FROM institutions WHERE id = ?`).get(id) as
    | { id: string; name: string; kind: string; municipality: string; dataset: string }
    | undefined
}

export function datasetStats(): { payments: number; institutions: number; recipients: number; real: number } {
  return sourceDb()
    .prepare(
      `SELECT COUNT(*) AS payments, COUNT(DISTINCT payer_id) AS institutions, COUNT(DISTINCT recipient_id) AS recipients,
              SUM(dataset = 'real') AS real FROM payments`,
    )
    .get() as { payments: number; institutions: number; recipients: number; real: number }
}
