import { createAgent, type Agent, type SituationHandler, type Tool } from "@mozaik-ai/core"
import type { AgentRole } from "../domain/types.js"
import { runtimeState } from "../runtime/runtime.js"

export const AGENT_NAMES: Record<AgentRole, string> = {
  coordinator: "Coordinator",
  price: "Price",
  procedure: "Procurement procedure",
  patterns: "Institution patterns",
  network: "Recipient network",
  risk: "Risk assessment",
  writer: "Dossier writer",
  verifier: "Verifier",
}

/** Create a long-lived Inquest agent and register its role. */
export function makeAgent(role: AgentRole, instruction: string, tools: Tool[], handlers: SituationHandler[]): Agent {
  const agent = createAgent({ name: AGENT_NAMES[role], capabilities: [`role:${role}`], instruction, tools, handlers })
  runtimeState().roles.set(agent.getId(), role)
  return agent
}

export function windowAround(date: string, days: number): { from: string; to: string } {
  const t = Date.parse(date)
  const d = days * 86_400_000
  return { from: new Date(t - d).toISOString().slice(0, 10), to: new Date(t + d).toISOString().slice(0, 10) }
}
