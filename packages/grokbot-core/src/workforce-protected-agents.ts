import type { Agent } from "./agents.js";
import { GrokBotError } from "./contracts.js";

/** The owner's main bot and the two test bots. */
export const PROTECTED_AGENT_IDS: ReadonlySet<string> = new Set([
  "00000000-0000-4000-8000-000000000000",
  "f882ec52-17b1-4639-b0fc-07fed7526b09",
  "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
]);

/**
 * Throws unless `agent` is unprotected or `force` is its full agentId. The override is
 * the id itself rather than a yes/no flag, so acting on a protected bot always names it.
 */
export function assertMayTouch(
  agent: Agent,
  force: string | undefined,
  command: string,
): void {
  if (!PROTECTED_AGENT_IDS.has(agent.agentId)) return;
  if (force?.trim().toLowerCase() === agent.agentId) return;
  throw new GrokBotError(
    "safety",
    `${agent.name} (${agent.agentId.slice(0, 8)}) is protected, so ${command} refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
  );
}
