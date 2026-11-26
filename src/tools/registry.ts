/**
 * Company register lookup.
 *
 * For the synthetic dataset the register is a fictional file that stands in
 * for a public business register; it is deliberately kept out of the payments
 * database so agents have to look companies up, like they would in reality.
 * Every record carries a source link.
 */
import { existsSync, readFileSync } from "node:fs"
import { CONFIG } from "../config.js"
import type { RegistryRecord } from "../domain/types.js"
import { sleep } from "../runtime/runtime.js"

let records: Map<string, RegistryRecord> | null = null

function load(): Map<string, RegistryRecord> {
  if (!records) {
    records = new Map()
    if (existsSync(CONFIG.registryPath)) {
      const data = JSON.parse(readFileSync(CONFIG.registryPath, "utf-8")) as { companies: RegistryRecord[] }
      for (const c of data.companies) records.set(c.id, c)
    }
  }
  return records
}

/** Simulated network latency of a register query (the real one is a remote service). */
const REGISTRY_LATENCY_MS = 40

export async function registryLookup(recipientId: string): Promise<RegistryRecord | null> {
  await sleep(REGISTRY_LATENCY_MS)
  return load().get(recipientId) ?? null
}
