import { writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { CONFIG } from "../config.js"
import { CaseBoard } from "../db/board.js"
import type { PaymentFilter } from "../db/source.js"
import { evaluate, type Evaluation } from "../eval/evaluate.js"
import { isFullRun } from "../cli/args.js"
import { runSingle } from "./single.js"
import type { RunStats } from "./stats.js"
import { runTeam } from "./team.js"

export interface Comparison {
  at: string
  filter: PaymentFilter
  speedup: number
  team: { stats: RunStats; evaluation: Evaluation | null }
  single: { stats: RunStats; evaluation: Evaluation | null }
}

export const COMPARISON_PATH = resolve(CONFIG.runsDir, "comparison.json")

export async function compare(filter: PaymentFilter): Promise<Comparison> {
  const full = isFullRun(filter)
  const teamStats = await runTeam(filter)
  const teamEval = full ? evaluate(CaseBoard.open("team")!) : null
  const singleStats = await runSingle(filter)
  const singleEval = full ? evaluate(CaseBoard.open("single")!) : null
  const result: Comparison = {
    at: new Date().toISOString(),
    filter,
    speedup: singleStats.durationMs / Math.max(1, teamStats.durationMs),
    team: { stats: teamStats, evaluation: teamEval },
    single: { stats: singleStats, evaluation: singleEval },
  }
  mkdirSync(CONFIG.runsDir, { recursive: true })
  writeFileSync(COMPARISON_PATH, JSON.stringify(result, null, 2))
  return result
}
