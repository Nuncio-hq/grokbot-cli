/**
 * Who called grokbot, as one label from a fixed set. Only the label is ever recorded:
 * raw environment values, session ids and emails are never read or kept.
 */
export const CLIENT_LABELS = [
  "human",
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "hermes",
  "other-agent",
  "script",
] as const;
export type ClientLabel = (typeof CLIENT_LABELS)[number];

export const isClientLabel = (value: unknown): value is ClientLabel =>
  CLIENT_LABELS.some((label) => label === value);

/** Maps a client or agent name (an MCP clientInfo name, AI_AGENT) to a label. */
export function labelForName(name: string): ClientLabel {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude-code";
  if (n.includes("codex")) return "codex";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("hermes")) return "hermes";
  return "other-agent";
}

export interface ClientSignals {
  /** The only environment variables read: GROKBOT_CLIENT, CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, AI_AGENT. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdin is a terminal, which a person typing has and an agent's shell does not. */
  readonly isTTY: boolean;
  /** The name an MCP client sent when it connected, if any. */
  readonly mcpClientName?: string;
}

/**
 * The caller, most specific signal first: an explicit GROKBOT_CLIENT, the MCP client's own
 * name, Claude Code's markers (CLAUDE_CODE_ENTRYPOINT is "claude-desktop" in the desktop
 * app), the AI_AGENT convention, then a terminal (a person) or none (a script).
 */
export function detectClient({
  env,
  isTTY,
  mcpClientName,
}: ClientSignals): ClientLabel {
  const explicit = env.GROKBOT_CLIENT?.trim();
  if (explicit)
    return isClientLabel(explicit) ? explicit : labelForName(explicit);
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT?.trim();
  if (mcpClientName?.trim()) {
    const label = labelForName(mcpClientName);
    // Claude Code names itself "claude-code" over MCP; keep the desktop app's label so one actor counts once.
    return label === "claude-code" && entrypoint === "claude-desktop"
      ? "claude-desktop"
      : label;
  }
  if (entrypoint === "claude-desktop") return "claude-desktop";
  if (entrypoint || env.CLAUDECODE === "1") return "claude-code";
  const agent = env.AI_AGENT?.trim();
  if (agent) return labelForName(agent);
  return isTTY ? "human" : "script";
}
