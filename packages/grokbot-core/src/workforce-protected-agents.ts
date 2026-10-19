import type { Agent } from "./agents.js";
import { GrokBotError } from "./contracts.js";
import type { ProtectedBots } from "./protected-bots-store.js";

/**
 * Throws if `agent` is in the user's protected list and `force` is not its full agentId.
 * The override is the id itself rather than a yes/no flag, so acting on a protected bot
 * always names it.
 */
export function assertMayTouch(
  agent: Agent,
  force: string | undefined,
  command: string,
  protectedBots: ProtectedBots,
): void {
  if (!protectedBots.has(agent.agentId.toLowerCase())) return;
  if (force?.trim().toLowerCase() === agent.agentId.toLowerCase()) return;
  throw new GrokBotError(
    "safety",
    `${agent.name} (${agent.agentId.slice(0, 8)}) is protected, so ${command} refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
  );
}
