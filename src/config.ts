/**
 * Central configuration: environment variables, file paths and the shared
 * reference data (categories, thresholds) produced alongside the dataset.
 */
import "dotenv/config"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const DATA_DIR = resolve(ROOT, "data")

export interface CategorySpec {
  label: string
  unit: string
  comparable: boolean
  marketSearch: boolean
  naturalMonopoly: boolean
  cpv: string[]
}

interface ReferenceFile {
  categories: Record<string, CategorySpec>
  allowedActivityPrefixes: Record<string, string[]>
  categoryGroups: Record<string, string[]>
  approvalThresholdsRsd: Record<string, number>
  procurementExemptionThresholdRsd: Record<string, number>
  minimumTenderDays: Record<string, number>
  eurToRsd: number
}

const reference = JSON.parse(
  readFileSync(resolve(DATA_DIR, "reference", "categories.json"), "utf-8"),
) as ReferenceFile

export const REFERENCE = reference

/** Group key used for concentration and splitting checks ("laptop" -> "it_equipment"). */
export function categoryGroup(category: string): string {
  for (const [group, members] of Object.entries(reference.categoryGroups)) {
    if (group.startsWith("_")) continue
    if (members.includes(category)) return group
  }
  return category
}

export function categoriesInGroup(group: string): string[] {
  return reference.categoryGroups[group] ?? [group]
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function hasLlmKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY)
}

const llmMode = (process.env.INQUEST_LLM_MODE ?? "auto").toLowerCase()

export const CONFIG = {
  dbPath: process.env.INQUEST_DB ?? resolve(DATA_DIR, "inquest.db"),
  webCachePath: process.env.INQUEST_WEB_CACHE ?? resolve(DATA_DIR, "cache", "web-cache.db"),
  registryPath: resolve(DATA_DIR, "registry", "fictional_registry.json"),
  truthPath: resolve(DATA_DIR, "truth", "ground_truth.json"),
  runsDir: process.env.INQUEST_RUNS_DIR ?? resolve(ROOT, "runs"),

  llm: {
    enabled: llmMode === "online" || (llmMode === "auto" && hasLlmKey()),
    modelFast: process.env.INQUEST_MODEL_FAST ?? "claude-haiku-4-5",
    modelSmart: process.env.INQUEST_MODEL_SMART ?? "claude-sonnet-5-5",
    concurrency: envNumber("INQUEST_LLM_CONCURRENCY", 8),
    budgetPerCase: envNumber("INQUEST_LLM_BUDGET_PER_CASE", 12),
    timeoutMs: envNumber("INQUEST_LLM_TIMEOUT_MS", 90_000),
    offlineLatencyMs: envNumber("INQUEST_OFFLINE_LATENCY_MS", 120),
    reportLanguage: (process.env.INQUEST_REPORT_LANGUAGE ?? "en") as "en" | "sr",
  },

  web: {
    mode: (process.env.INQUEST_WEB_MODE ?? "live") as "live" | "cache",
    tavilyKey: process.env.TAVILY_API_KEY,
    braveKey: process.env.BRAVE_API_KEY,
    maxPagesPerPayment: envNumber("INQUEST_WEB_MAX_PAGES", 6),
    fetchTimeoutMs: envNumber("INQUEST_WEB_TIMEOUT_MS", 12_000),
  },

  investigation: {
    /** Maximum branching depth from the initial payment (payment -> entity -> entity). */
    maxHops: 2,
    /** Only payments within this window around the root payment are pulled into a branch. */
    windowDays: 730,
    /** Risk score at or above which a case counts as flagged and gets a dossier. */
    flagThreshold: 0.5,
    /** How long a case must be quiet before the Risk agent scores it. */
    caseQuietMs: envNumber("INQUEST_CASE_QUIET_MS", 400),
    /** Max payments being screened at once (back-pressure for the Coordinator). */
    maxPaymentsInFlight: envNumber("INQUEST_MAX_PAYMENTS_IN_FLIGHT", 64),
    /** Max writer -> verifier revision rounds per dossier. */
    maxRevisions: 2,
  },

  server: {
    port: envNumber("PORT", 8787),
  },
}

export type InquestConfig = typeof CONFIG
