/** Run the single-agent sequential baseline (same skills, no concurrency). */
import { CaseBoard } from "../db/board.js"
import { evaluate, formatEvaluation } from "../eval/evaluate.js"
import { runSingle } from "../run/single.js"
import { parseFilter } from "./args.js"
import { printCases, printStats } from "./print.js"

const filter = parseFilter()
const stats = await runSingle(filter)
printStats(stats)
const board = CaseBoard.open("single")!
printCases(board)
console.log("\n" + formatEvaluation(evaluate(board)))
process.exit(0)
