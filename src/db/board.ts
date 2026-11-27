/**
 * The case board: shared investigation state in SQLite.
 *
 * Every change made here is also published as a Mozaik event by the caller,
 * so other agents can react to it. The board has a single writer for cases
 * (the Coordinator attaches signals and findings), while any agent may claim
 * an entity. Claims use INSERT OR IGNORE, so exactly one agent wins a claim
 * even when two investigations reach the same supplier at the same moment.
 */
import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { CONFIG } from "../config.js"
import { SIGNALS } from "../domain/signal-catalog.js"
import type { CaseRow, EntityRef, Fact, Finding, PriceReference, Signal, SignalDraft } from "../domain/types.js"
import { getPayment } from "./source.js"

const SCHEMA = `
CREATE TABLE runs (id TEXT PRIMARY KEY, mode TEXT, started_at TEXT, finished_at TEXT, stats_json TEXT);
CREATE TABLE cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  merged_into INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  score REAL,
  score_rationale TEXT,
  explanation TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  scored_revision INTEGER,
  root_payment_id TEXT,
  parent_id INTEGER,
  merge_reason TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_signal_at_ms INTEGER,
  approved_at_ms INTEGER
);
CREATE TABLE case_payments (case_id INTEGER NOT NULL, payment_id TEXT NOT NULL, PRIMARY KEY (case_id, payment_id));
CREATE INDEX idx_case_payments_payment ON case_payments(payment_id);
CREATE TABLE case_entities (case_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, entity_name TEXT,
  PRIMARY KEY (case_id, entity_type, entity_id));
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  agent TEXT NOT NULL,
  strength REAL NOT NULL,
  summary TEXT NOT NULL,
  rule TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  recipient_id TEXT,
  payment_ids_json TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  explanation TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_signals_pair ON signals(payer_id, recipient_id);
CREATE TABLE claims (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, agent TEXT NOT NULL, case_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id, agent));
CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL, agent TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL, payment_ids_json TEXT NOT NULL,
  facts_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE price_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT,
  price REAL, currency TEXT, normalized_rsd REAL, includes TEXT, quote TEXT, verified INTEGER, verify_note TEXT, created_at TEXT NOT NULL);
CREATE TABLE dossiers (case_id INTEGER NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
  facts_json TEXT NOT NULL, status TEXT NOT NULL, checks_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (case_id, version));
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, type TEXT NOT NULL, producer TEXT,
  producer_role TEXT, payload_json TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, agent TEXT NOT NULL, payment_id TEXT, text TEXT NOT NULL);
CREATE INDEX idx_cases_merged_into ON cases(merged_into);
CREATE INDEX idx_signals_case ON signals(case_id);
CREATE INDEX idx_findings_case ON findings(case_id);
CREATE INDEX idx_case_entities_entity ON case_entities(entity_type, entity_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_price_refs_payment ON price_refs(payment_id);
`

export type BoardMode = "team" | "single"

export function boardPath(mode: BoardMode): string {
  return resolve(CONFIG.runsDir, `board-${mode}.db`)
}

export interface AttachResult {
  caseId: number
  signalId: number | null
  isNew: boolean
  created: boolean
  /** Cases that were merged into caseId while attaching. */
  merged: number[]
}

export class CaseBoard {
  readonly db: Database.Database

  private constructor(db: Database.Database, readonly mode: BoardMode) {
    this.db = db
    // Reuse prepared statements: the board runs the same few queries hundreds of
    // thousands of times on large datasets, and preparing is the expensive part.
    const statements = new Map<string, Database.Statement>()
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      let stmt = statements.get(sql)
      if (!stmt) {
        stmt = prepare(sql)
        statements.set(sql, stmt)
      }
      return stmt
    }) as typeof db.prepare
  }

  /**
   * Create a fresh, empty board for a run. Tables are dropped and recreated in
   * place rather than deleting the file, because on Windows a file that another
   * connection (e.g. the dashboard server) has open cannot be deleted.
   */
  static fresh(mode: BoardMode): CaseBoard {
    mkdirSync(CONFIG.runsDir, { recursive: true })
    const db = new Database(boardPath(mode))
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = NORMAL")
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>
    db.transaction(() => {
      for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name}"`)
      db.exec(SCHEMA)
    })()
    return new CaseBoard(db, mode)
  }

  /** Open an existing board (read-mostly, e.g. for the server or evaluator). */
  static open(mode: BoardMode): CaseBoard | null {
    const path = boardPath(mode)
    if (!existsSync(path)) return null
    const db = new Database(path)
    db.pragma("journal_mode = WAL")
    return new CaseBoard(db, mode)
  }

  close(): void {
    this.flushEvents()
    this.db.close()
  }

  // ---------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------

  /** Follow merged_into links to the surviving case. */
  resolveCase(id: number): number {
    let current = id
    for (let i = 0; i < 50; i++) {
      const row = this.db.prepare(`SELECT merged_into FROM cases WHERE id = ?`).get(current) as { merged_into: number | null } | undefined
      if (!row?.merged_into) return current
      current = row.merged_into
    }
    return current
  }

  /** The case and every case merged into it, directly or through other merged cases. */
  mergedFamily(caseId: number): number[] {
    const rows = this.db.prepare(
      `WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT c.id FROM cases c JOIN family f ON c.merged_into = f.id) SELECT id FROM family`,
    ).all(caseId) as Array<{ id: number }>
    return rows.map((r) => r.id)
  }

  getCase(id: number): CaseRow | undefined {
    return this.db.prepare(`SELECT * FROM cases WHERE id = ?`).get(id) as CaseRow | undefined
  }

  listCases(opts: { includeMerged?: boolean } = {}): Array<CaseRow & { score_rationale: string | null; explanation: string | null }> {
    return this.db
      .prepare(
        `SELECT * FROM cases ${opts.includeMerged ? "" : "WHERE status != 'merged'"}
         ORDER BY COALESCE(score, -1) DESC, priority DESC, id`,
      )
      .all() as Array<CaseRow & { score_rationale: string | null; explanation: string | null }>
  }

  private now(): string {
    return new Date().toISOString()
  }

  private createCase(title: string, rootPaymentId: string | null, hop: number, createdBy: string, parentId: number | null = null): number {
    const now = this.now()
    const info = this.db
      .prepare(
        `INSERT INTO cases (title, root_payment_id, parent_id, hop, created_by, created_at, updated_at, first_signal_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(title, rootPaymentId, parentId, hop, createdBy, now, now, Date.now())
    return Number(info.lastInsertRowid)
  }

  /**
   * Open a new line of investigation on an entity, branching from a case.
   * It becomes its own case on the board until it meets another line.
   */
  createBranchCase(parentId: number, entity: EntityRef, hop: number, createdBy: string): number {
    const parent = this.getCase(this.resolveCase(parentId))
    const id = this.createCase(`${entity.name ?? entity.id} (${entity.type} branch of #${parent?.id ?? parentId})`, parent?.root_payment_id ?? null, hop, createdBy, parent?.id ?? parentId)
    this.linkEntity(id, entity)
    return id
  }

  /** A branch that found nothing new is folded back into its parent (not counted as a meeting). */
  closeBranch(caseId: number): number | null {
    const c = this.getCase(caseId)
    if (!c || c.status === "merged" || !c.parent_id) return null
    const signals = (this.db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE case_id = ?`).get(caseId) as { n: number }).n
    if (signals > 0) return null
    const [survivor] = this.mergeCases([this.resolveCase(c.parent_id), caseId], "closed")
    return survivor
  }

  private touch(caseId: number): void {
    this.db.prepare(`UPDATE cases SET revision = revision + 1, updated_at = ? WHERE id = ?`).run(this.now(), caseId)
  }

  private linkPayments(caseId: number, paymentIds: string[]): void {
    const insertPayment = this.db.prepare(`INSERT OR IGNORE INTO case_payments (case_id, payment_id) VALUES (?, ?)`)
    const insertEntity = this.db.prepare(
      `INSERT OR IGNORE INTO case_entities (case_id, entity_type, entity_id, entity_name) VALUES (?, ?, ?, ?)`,
    )
    for (const pid of paymentIds) {
      insertPayment.run(caseId, pid)
      const p = getPayment(pid)
      if (p) {
        insertEntity.run(caseId, "payer", p.payer_id, p.payer_name)
        insertEntity.run(caseId, "recipient", p.recipient_id, p.recipient_name)
      }
    }
  }

  linkEntity(caseId: number, entity: EntityRef): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO case_entities (case_id, entity_type, entity_id, entity_name) VALUES (?, ?, ?, ?)`)
      .run(caseId, entity.type, entity.id, entity.name ?? null)
  }

  private openCasesForPayments(paymentIds: string[]): number[] {
    if (!paymentIds.length) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT case_id FROM case_payments WHERE payment_id IN (${paymentIds.map(() => "?").join(",")})`,
      )
      .all(...paymentIds) as Array<{ case_id: number }>
    return [...new Set(rows.map((r) => this.resolveCase(r.case_id)))]
  }

  /** Cases that already hold a signal about the same payer-recipient pair. */
  casesForPair(payerId: string, recipientId: string): number[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT case_id FROM signals WHERE payer_id = ? AND recipient_id = ?`)
      .all(payerId, recipientId) as Array<{ case_id: number }>
    return [...new Set(rows.map((r) => this.resolveCase(r.case_id)))]
  }

  /**
   * Merge several cases into the oldest one. Returns [survivor, mergedIds].
   * All rows of the merged cases move to the survivor; its priority rises,
   * because two independent lines of investigation met.
   */
  mergeCases(caseIds: number[], reason = "meeting"): [number, number[]] {
    const ids = [...new Set(caseIds.map((id) => this.resolveCase(id)))].sort((a, b) => a - b)
    if (ids.length < 2) return [ids[0], []]
    const [survivor, ...others] = ids
    const meeting = reason !== "closed"
    const tx = this.db.transaction(() => {
      for (const other of others) {
        this.db.prepare(`INSERT OR IGNORE INTO case_payments SELECT ?, payment_id FROM case_payments WHERE case_id = ?`).run(survivor, other)
        this.db.prepare(`INSERT OR IGNORE INTO case_entities SELECT ?, entity_type, entity_id, entity_name FROM case_entities WHERE case_id = ?`).run(survivor, other)
        this.db.prepare(`UPDATE signals SET case_id = ? WHERE case_id = ?`).run(survivor, other)
        this.db.prepare(`UPDATE findings SET case_id = ? WHERE case_id = ?`).run(survivor, other)
        this.db.prepare(`UPDATE claims SET case_id = ? WHERE case_id = ?`).run(survivor, other)
        this.db.prepare(`UPDATE cases SET status = 'merged', merged_into = ?, merge_reason = ?, updated_at = ? WHERE id = ?`).run(survivor, reason, this.now(), other)
      }
      // Two independent lines of investigation meeting raises the priority.
      const maxPriority = (this.db
        .prepare(`SELECT MAX(priority) AS p FROM cases WHERE id IN (${ids.map(() => "?").join(",")})`)
        .get(...ids) as { p: number }).p
      this.db
        .prepare(`UPDATE cases SET priority = ?, status = 'open', revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(maxPriority + (meeting ? others.length : 0), this.now(), survivor)
    })
    tx()
    return [survivor, others]
  }

  /**
   * Attach a signal to the right case, creating or merging cases as needed.
   * `caseHint` is the case of the investigation branch that produced the signal.
   */
  attachSignal(draft: SignalDraft, opts: { caseHint?: number; hop?: number; createdBy: string }): AttachResult {
    const existing = this.db.prepare(`SELECT id, case_id FROM signals WHERE key = ?`).get(draft.key) as
      | { id: number; case_id: number }
      | undefined
    if (existing) {
      const target = this.resolveCase(existing.case_id)
      if (opts.caseHint !== undefined && this.resolveCase(opts.caseHint) !== target) {
        const [survivor, merged] = this.mergeCases([target, opts.caseHint])
        return { caseId: survivor, signalId: existing.id, isNew: false, created: false, merged }
      }
      return { caseId: target, signalId: existing.id, isNew: false, created: false, merged: [] }
    }

    let candidates = this.openCasesForPayments(draft.paymentIds)
    if (opts.caseHint !== undefined) {
      candidates.push(this.resolveCase(opts.caseHint))
      if (draft.recipientId) candidates.push(...this.casesForPair(draft.payerId, draft.recipientId))
    }
    candidates = [...new Set(candidates)]

    let caseId: number
    let created = false
    let merged: number[] = []
    if (candidates.length === 0) {
      const p = getPayment(draft.paymentIds[0])
      const title = p
        ? `${p.payer_name}${draft.recipientId ? " / " + p.recipient_name : ""}`
        : `${SIGNALS[draft.code].name}`
      caseId = this.createCase(title, draft.paymentIds[0] ?? null, opts.hop ?? 0, opts.createdBy)
      created = true
    } else if (candidates.length === 1) {
      caseId = candidates[0]
    } else {
      ;[caseId, merged] = this.mergeCases(candidates)
    }

    const info = this.db
      .prepare(
        `INSERT INTO signals (case_id, key, code, agent, strength, summary, rule, payer_id, recipient_id, payment_ids_json,
          facts_json, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        caseId, draft.key, draft.code, draft.agent, draft.strength, draft.summary, draft.rule, draft.payerId,
        draft.recipientId, JSON.stringify(draft.paymentIds), JSON.stringify(draft.facts), draft.explanation ?? null,
        this.now(),
      )
    this.linkPayments(caseId, draft.paymentIds)
    this.touch(caseId)
    return { caseId, signalId: Number(info.lastInsertRowid), isNew: true, created, merged }
  }

  /** Attach a branch finding to its case; merges with cases that hold the same payments or pair. */
  addFinding(finding: Finding): { caseId: number; merged: number[] } {
    let candidates = [this.resolveCase(finding.caseId), ...this.openCasesForPayments(finding.paymentIds)]
    candidates = [...new Set(candidates)]
    let [caseId, merged] = candidates.length > 1 ? this.mergeCases(candidates) : [candidates[0], [] as number[]]
    this.db
      .prepare(
        `INSERT INTO findings (case_id, agent, entity_type, entity_id, summary, payment_ids_json, facts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(caseId, finding.agent, finding.entity.type, finding.entity.id, finding.summary,
        JSON.stringify(finding.paymentIds), JSON.stringify(finding.facts), this.now())
    this.linkEntity(caseId, finding.entity)
    this.touch(caseId)
    return { caseId, merged }
  }

  // ---------------------------------------------------------------------------
  // Claims
  // ---------------------------------------------------------------------------

  /**
   * Claim an entity for investigation by one agent role. Returns whether this
   * call won the claim, and which case owns the investigation.
   */
  claimEntity(entity: EntityRef, agent: string, caseId: number): { claimed: boolean; ownerCaseId: number } {
    const info = this.db
      .prepare(`INSERT OR IGNORE INTO claims (entity_type, entity_id, agent, case_id, claimed_at) VALUES (?, ?, ?, ?, ?)`)
      .run(entity.type, entity.id, agent, caseId, this.now())
    if (info.changes === 1) return { claimed: true, ownerCaseId: caseId }
    const row = this.db
      .prepare(`SELECT case_id FROM claims WHERE entity_type = ? AND entity_id = ? AND agent = ?`)
      .get(entity.type, entity.id, agent) as { case_id: number }
    return { claimed: false, ownerCaseId: this.resolveCase(row.case_id) }
  }

  // ---------------------------------------------------------------------------
  // Reads for agents and the dashboard
  // ---------------------------------------------------------------------------

  caseSignals(caseId: number): Signal[] {
    const rows = this.db.prepare(`SELECT * FROM signals WHERE case_id = ? ORDER BY id`).all(caseId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: r.id as number,
      caseId: r.case_id as number,
      key: r.key as string,
      code: r.code as Signal["code"],
      agent: r.agent as Signal["agent"],
      strength: r.strength as number,
      summary: r.summary as string,
      rule: r.rule as string,
      payerId: r.payer_id as string,
      recipientId: (r.recipient_id as string) ?? null,
      paymentIds: JSON.parse(r.payment_ids_json as string),
      facts: JSON.parse(r.facts_json as string),
      explanation: (r.explanation as string) ?? null,
      createdAt: r.created_at as string,
    }))
  }

  casePaymentIds(caseId: number): string[] {
    return (this.db.prepare(`SELECT payment_id FROM case_payments WHERE case_id = ? ORDER BY payment_id`).all(caseId) as Array<{ payment_id: string }>).map(
      (r) => r.payment_id,
    )
  }

  caseEntities(caseId: number): EntityRef[] {
    return (this.db.prepare(`SELECT entity_type, entity_id, entity_name FROM case_entities WHERE case_id = ?`).all(caseId) as Array<{
      entity_type: EntityRef["type"]
      entity_id: string
      entity_name: string | null
    }>).map((r) => ({ type: r.entity_type, id: r.entity_id, name: r.entity_name ?? undefined }))
  }

  caseFindings(caseId: number): Array<Finding & { id: number; createdAt: string }> {
    const rows = this.db.prepare(`SELECT * FROM findings WHERE case_id = ? ORDER BY id`).all(caseId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: r.id as number,
      caseId: r.case_id as number,
      agent: r.agent as Finding["agent"],
      entity: { type: r.entity_type as EntityRef["type"], id: r.entity_id as string },
      summary: r.summary as string,
      paymentIds: JSON.parse(r.payment_ids_json as string),
      facts: JSON.parse(r.facts_json as string) as Fact[],
      createdAt: r.created_at as string,
    }))
  }

  setScore(caseId: number, score: number, rationale: string, explanation: string | null, revision: number): void {
    this.db
      .prepare(
        `UPDATE cases SET score = ?, score_rationale = ?, explanation = ?, scored_revision = ?,
         status = CASE WHEN status IN ('open','scored') THEN 'scored' ELSE status END, updated_at = ? WHERE id = ?`,
      )
      .run(score, rationale, explanation, revision, this.now(), caseId)
  }

  setStatus(caseId: number, status: CaseRow["status"]): void {
    this.db
      .prepare(`UPDATE cases SET status = ?, updated_at = ?, approved_at_ms = CASE WHEN ? = 'approved' THEN ? ELSE approved_at_ms END WHERE id = ?`)
      .run(status, this.now(), status, Date.now(), caseId)
  }

  savePriceRefs(paymentId: string, refs: PriceReference[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO price_refs (payment_id, url, title, price, currency, normalized_rsd, includes, quote, verified, verify_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of refs) {
      stmt.run(paymentId, r.url, r.title, r.price, r.currency, r.normalizedRsd, r.includes, r.quote,
        r.verified === undefined ? null : Number(r.verified), r.verifyNote ?? null, this.now())
    }
  }

  priceRefs(paymentIds: string[]): Array<PriceReference & { payment_id: string }> {
    if (!paymentIds.length) return []
    return (this.db
      .prepare(`SELECT * FROM price_refs WHERE payment_id IN (${paymentIds.map(() => "?").join(",")})`)
      .all(...paymentIds) as Array<Record<string, unknown>>).map((r) => ({
      payment_id: r.payment_id as string,
      url: r.url as string,
      title: r.title as string,
      price: r.price as number,
      currency: r.currency as string,
      normalizedRsd: r.normalized_rsd as number,
      includes: r.includes as string,
      quote: r.quote as string,
      verified: r.verified === null ? undefined : Boolean(r.verified),
      verifyNote: (r.verify_note as string) ?? undefined,
    }))
  }

  addNote(agent: string, paymentId: string | null, text: string): void {
    this.db.prepare(`INSERT INTO notes (at_ms, agent, payment_id, text) VALUES (?, ?, ?, ?)`).run(Date.now(), agent, paymentId, text)
  }

  saveDossier(caseId: number, version: number, title: string, bodyMd: string, facts: Fact[], status: string, checks: unknown): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dossiers (case_id, version, title, body_md, facts_json, status, checks_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(caseId, version, title, bodyMd, JSON.stringify(facts), status, JSON.stringify(checks ?? null), this.now())
  }

  setDossierStatus(caseId: number, version: number, status: string, checks: unknown): void {
    this.db
      .prepare(`UPDATE dossiers SET status = ?, checks_json = ? WHERE case_id = ? AND version = ?`)
      .run(status, JSON.stringify(checks ?? null), caseId, version)
  }

  dossiers(caseId: number): Array<{ version: number; title: string; body_md: string; facts: Fact[]; status: string; checks: unknown }> {
    return (this.db.prepare(`SELECT * FROM dossiers WHERE case_id = ? ORDER BY version`).all(caseId) as Array<Record<string, unknown>>).map(
      (r) => ({
        version: r.version as number,
        title: r.title as string,
        body_md: r.body_md as string,
        facts: JSON.parse(r.facts_json as string),
        status: r.status as string,
        checks: r.checks_json ? JSON.parse(r.checks_json as string) : null,
      }),
    )
  }

  private eventBuffer: Array<[number, string, string, string | null, string]> = []
  private flushTimer: NodeJS.Timeout | null = null

  /** Events are buffered and written in one transaction every 200 ms (tens of thousands per run). */
  logEvent(type: string, producer: string, producerRole: string | null, payload: unknown): void {
    this.eventBuffer.push([Date.now(), type, producer, producerRole, JSON.stringify(payload ?? null)])
    this.flushTimer ??= setTimeout(() => this.flushEvents(), 200)
  }

  flushEvents(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.eventBuffer.length || !this.db.open) return
    const rows = this.eventBuffer.splice(0)
    const stmt = this.db.prepare(`INSERT INTO events (at_ms, type, producer, producer_role, payload_json) VALUES (?, ?, ?, ?, ?)`)
    this.db.transaction(() => {
      for (const r of rows) stmt.run(...r)
    })()
  }

  startRun(id: string, mode: string): void {
    this.db.prepare(`INSERT INTO runs (id, mode, started_at) VALUES (?, ?, ?)`).run(id, mode, this.now())
  }

  finishRun(id: string, stats: unknown): void {
    this.flushEvents()
    this.db.prepare(`UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?`).run(this.now(), JSON.stringify(stats), id)
  }

  lastRun(): { id: string; mode: string; started_at: string; finished_at: string | null; stats: unknown } | undefined {
    const r = this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      id: r.id as string,
      mode: r.mode as string,
      started_at: r.started_at as string,
      finished_at: (r.finished_at as string) ?? null,
      stats: r.stats_json ? JSON.parse(r.stats_json as string) : null,
    }
  }
}
