/** Typed access to the Inquest server API. */

export type Mode = "team" | "single"

export interface SignalInfo {
  code: string
  name: string
  ocp: string | null
  agent: string
  layer: string
  description: string
}

export interface RunStats {
  runId: string
  mode: Mode
  payments: number
  durationMs: number
  cases: number
  flaggedCases: number
  approvedDossiers: number
  mergedCases: number
  signals: Record<string, number>
  rejectedDossierVersions: number
  correctedFacts: number
  avgSecondsToApprovedDossier: number | null
  llm: { enabled: boolean; modelFast: string; modelSmart: string; llmCalls: number; llmOfflineCalls: number; llmFailures: number; inputTokens: number; outputTokens: number }
  web: { mode: string; searches: number; pages: number }
  events: number
}

export interface ServerState {
  activeRun: { mode: string; startedAt: number } | null
  lastError: string | null
  dataset: { payments: number; institutions: number; recipients: number; real: number }
  llm: { enabled: boolean; modelFast: string; modelSmart: string; language: string }
  web: string
  runs: Record<Mode, { id: string; started_at: string; finished_at: string | null; stats: RunStats | null } | null>
  flagThreshold: number
  signals: Record<string, SignalInfo>
}

export interface CaseSummary {
  id: number
  title: string
  status: string
  score: number | null
  priority: number
  hop: number
  parentId: number | null
  flagged: boolean
  signals: string[]
  agents: string[]
  payments: number
  dossierVersions: number
  dossierStatus: string | null
  dataset: string
}

export interface Payment {
  id: string
  payer_id: string
  payer_name: string
  recipient_id: string
  recipient_name: string
  amount: number
  date: string
  category: string
  description: string | null
  source: string
  source_ref: string
  status: string
}

export interface CaseDetail {
  case: { id: number; title: string; status: string; score: number | null; score_rationale: string | null; explanation: string | null; priority: number; hop: number; parent_id: number | null }
  signals: Array<{ id: number; code: string; agent: string; strength: number; summary: string; rule: string; explanation: string | null; paymentIds: string[]; info: SignalInfo }>
  findings: Array<{ id: number; agent: string; entity: { type: string; id: string; name?: string }; summary: string }>
  entities: Array<{ type: string; id: string; name?: string }>
  payments: Payment[]
  priceRefs: Array<{ url: string; title: string; price: number; currency: string; normalizedRsd: number; quote: string; verified?: boolean; verifyNote?: string }>
  dossiers: Array<{ version: number; title: string; body_md: string; status: string; checks: unknown }>
  merged: Array<{ id: number; title: string; reason: string | null }>
}

export interface GraphData {
  nodes: Array<{ id: string; label: string; type: "payer" | "recipient"; flagged: boolean; kind?: string }>
  edges: Array<{ id: string; source: string; target: string; amount: number; count: number; flagged: boolean; cases: number[] }>
}

export interface Evaluation {
  injected: number
  detected: number
  detectionRate: number
  correctSignal: number
  correctSignalRate: number
  expectedSignalRecall: number
  cleanPayments: number
  falseAlarms: number
  falseAlarmRate: number
  flaggedShare: { procurement: number; ledgers: number; real: number | null }
  verifierRejections: number
  verifierCorrections: number
  scope: { screenedPayments: number; totalPayments: number; injectedOutOfScope: number; full: boolean; realScreened: number }
  cases: Array<{ id: string; title: string; detected: boolean; score: number | null; primarySignal: string; primaryFound: boolean; foundSignals: string[]; caseIds: number[] }>
}

export interface Comparison {
  at: string
  speedup: number
  team: { stats: RunStats; evaluation: Evaluation | null }
  single: { stats: RunStats; evaluation: Evaluation | null }
}

export interface LiveEvent {
  id: number
  at: number
  type: string
  producer: string
  role: string | null
  payload: any
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  state: () => get<ServerState>("/api/state"),
  cases: (mode: Mode) => get<CaseSummary[]>(`/api/cases?mode=${mode}`),
  caseDetail: (mode: Mode, id: number) => get<CaseDetail>(`/api/cases/${id}?mode=${mode}`),
  graph: (mode: Mode) => get<GraphData>(`/api/graph?mode=${mode}`),
  events: (mode: Mode) => get<LiveEvent[]>(`/api/events?mode=${mode}&limit=600`),
  evaluation: (mode: Mode) => get<Evaluation | null>(`/api/eval?mode=${mode}`),
  comparison: () => get<Comparison | null>("/api/comparison"),
  realSummary: (mode: Mode) => get<{ payments: number; flaggedPayments: number; bySignal: Record<string, number> } | null>(`/api/real-summary?mode=${mode}`),
  run: async (mode: "team" | "single" | "compare", opts: { payers?: string[]; dataset?: "synthetic" | "real" } = {}) => {
    const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, ...opts }) })
    return res.ok
  },
}

export const ROLE_LABEL: Record<string, string> = {
  coordinator: "Coordinator",
  price: "Price",
  procedure: "Procurement procedure",
  patterns: "Institution patterns",
  network: "Recipient network",
  risk: "Risk assessment",
  writer: "Dossier writer",
  verifier: "Verifier",
  single: "Solo investigator",
}

export const ROLE_ORDER = ["coordinator", "price", "procedure", "patterns", "network", "risk", "writer", "verifier"]

export const rsd = (x: number) => `${Math.round(x).toLocaleString("en-US")} RSD`
export const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`
