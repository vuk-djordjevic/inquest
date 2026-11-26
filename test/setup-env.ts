/** Imported first by tests: keep test runs out of the real runs/ folder. */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.INQUEST_RUNS_DIR ??= join(mkdtempSync(join(tmpdir(), "inquest-runs-")), "runs")
