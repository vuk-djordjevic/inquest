/** Evaluate the last team (and single-agent, if present) run against the ground truth. */
import { CaseBoard } from "../db/board.js"
import { evaluate, formatEvaluation } from "../eval/evaluate.js"

for (const mode of ["team", "single"] as const) {
  const board = CaseBoard.open(mode)
  if (!board) continue
  console.log(`\n=== ${mode === "team" ? "Agent team" : "Single agent"}\n`)
  console.log(formatEvaluation(evaluate(board)))
}
