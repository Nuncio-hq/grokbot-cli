import type { Agent, AgentSuggestion } from "./agents.js";
import { GrokBotError } from "./contracts.js";
import { badChoice } from "./workforce-team-wire.js";

/** Why a suggestion is closed: the user hid it, or used it. */
export const REASON_WIRE = {
  hidden: "GROK_BOT_AGENT_SUGGESTION_DISMISS_REASON_HIDDEN",
  acted: "GROK_BOT_AGENT_SUGGESTION_DISMISS_REASON_ACTED",
} as const;
export type DismissReason = keyof typeof REASON_WIRE;

/** The `--reason` value; matched without regard to case. */
export function parseDismissReason(value: string): DismissReason {
  const wanted = value.trim().toLowerCase();
  const reason = (Object.keys(REASON_WIRE) as DismissReason[]).find(
    (r) => r === wanted,
  );
  if (reason) return reason;
  throw badChoice("reason", Object.keys(REASON_WIRE), value);
}

/**
 * The bot's suggestions named by `ids`, each once, in the order given. An id the roster
 * does not list stops the command before anything is sent.
 */
export function pickSuggestions(
  agent: Agent,
  ids: readonly string[],
): readonly AgentSuggestion[] {
  const known = agent.suggestions ?? [];
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (wanted.length === 0) {
    throw new GrokBotError(
      "safety",
      "Pass at least one suggestion id with --suggestion (from grokbot suggestions).",
    );
  }
  const missing = wanted.filter((id) => !known.some((s) => s.id === id));
  if (missing.length > 0) {
    throw new GrokBotError(
      "not-found",
      known.length === 0
        ? `${agent.name} has no suggestions to dismiss.`
        : `${agent.name} has no suggestion ${missing.map((id) => JSON.stringify(id)).join(", ")}. Its suggestions: ${known.map((s) => s.id).join(", ")}. grokbot suggestions lists them.`,
    );
  }
  return wanted.flatMap((id) => known.filter((s) => s.id === id));
}
