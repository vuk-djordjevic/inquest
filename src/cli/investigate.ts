/**
 * Run the agent team over the dataset (or a subset) and print the results.
 *
 *   npm run investigate                         # everything
 *   npm run investigate -- --payers MU03,SC03   # only these payers' payments
 *   npm run investigate -- --limit 500
 */
import { CaseBoard } from "../db/board.js"
import { evaluate, formatEvaluation } from "../eval/evaluate.js"
import { runTeam } from "../run/team.js"
import { parseFilter } from "./args.js"
import { printCases, printStats } from "./print.js"

const filter = parseFilter()
const stats = await runTeam(filter)
printStats(stats)
const board = CaseBoard.open("team")!
printCases(board)
console.log("\n" + formatEvaluation(evaluate(board)))
process.exit(0)
