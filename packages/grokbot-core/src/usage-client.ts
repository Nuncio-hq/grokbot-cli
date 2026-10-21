import type { ProcessChain } from "./process-chain.js";

/**
 * Who called grokbot, as one label from a fixed set. Only the label (and the name of the
 * signal that decided it) is ever kept: raw environment values, session ids and emails
 * are never read into a result or recorded. The caller's session is found apart from
 * this (caller-session.ts) and never reaches a client result or the usage log.
 */
export const CLIENT_LABELS = [
  "human",
  "omp",
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "hermes",
  "copilot",
  "junie",
  "auggie",
  "goose",
  "replit",
  "pi",
  "other-agent",
  "script",
] as const;
export type ClientLabel = (typeof CLIENT_LABELS)[number];

/** How each label reads in a message to a bot or in `grokbot whoami`. */
export const CLIENT_NAMES: Readonly<Record<ClientLabel, string>> = {
  human: "terminal",
  omp: "omp",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  hermes: "Hermes",
  copilot: "GitHub Copilot",
  junie: "Junie",
  auggie: "Auggie",
  goose: "Goose",
  replit: "Replit",
  pi: "pi",
  "other-agent": "an AI agent",
  script: "script",
};

const isClientLabel = (value: unknown): value is ClientLabel =>
  CLIENT_LABELS.some((label) => label === value);

/** Maps a client or agent name (an MCP clientInfo name, AI_AGENT) to a label. */
export function labelForName(name: string): ClientLabel {
  const n = name.toLowerCase();
  // Short names match whole words only, so "omp" is not found inside "compose".
  const words = n.split(/[^a-z0-9]+/);
  if (n.includes("claude")) return "claude-code";
  if (n.includes("codex")) return "codex";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("hermes")) return "hermes";
  if (n.includes("gemini")) return "gemini";
  if (n.includes("opencode")) return "opencode";
  if (n.includes("copilot")) return "copilot";
  if (n.includes("junie")) return "junie";
  if (n.includes("auggie") || n.includes("augment")) return "auggie";
  if (n.includes("goose")) return "goose";
  if (n.includes("replit")) return "replit";
  if (words.includes("omp") || n.includes("oh-my-pi")) return "omp";
  if (words.includes("pi")) return "pi";
  return "other-agent";
}

export interface ClientSignals {
  /**
   * The only environment variables read: GROKBOT_CLIENT, AI_AGENT, each runtime's own
   * marker (OMPCODE, CODEX_THREAD_ID, CODEX_SANDBOX, GEMINI_CLI, OPENCODE, CURSOR_AGENT,
   * COPILOT_AGENT, COPILOT_CLI, JUNIE_DATA, AUGMENT_AGENT, GOOSE_PROVIDER, REPL_ID),
   * PATH, and the markers other runtimes imitate (CLAUDE_CODE_ENTRYPOINT, CLAUDECODE,
   * CLAUDE_CODE).
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdin is a terminal, which a person typing has and an agent's shell does not. */
  readonly isTTY: boolean;
  /** The name an MCP client sent when it connected, if any. */
  readonly mcpClientName?: string;
  /**
   * The programs that started this process, nearest first (`readProcessChain` for the real
   * one, a fixed list in tests). Called only when no explicit signal decided the caller.
   */
  readonly processChain: ProcessChain;
}

/** The caller and the signal that decided it: a variable's name or a source, never a value. */
export interface DetectedClient {
  readonly label: ClientLabel;
  /** `GROKBOT_CLIENT`, `MCP client`, `process <name>`, a variable's name, `PATH`, or the terminal. */
  readonly signal: string;
}

/**
 * Executable (or script) names of the runtimes, as they show in a process list. Only a
 * runtime's own command is listed: an editor's name would also match a person's terminal.
 */
const PROCESS_RUNTIMES: Readonly<Record<string, ClientLabel>> = {
  omp: "omp",
  claude: "claude-code",
  codex: "codex",
  "cursor-agent": "cursor",
  gemini: "gemini",
  opencode: "opencode",
  hermes: "hermes",
  copilot: "copilot",
  junie: "junie",
  auggie: "auggie",
  goose: "goose",
  pi: "pi",
};

/** Runtime markers, most specific first: each is set only by that runtime itself. */
const RUNTIME_MARKERS: readonly (readonly [ClientLabel, readonly string[]])[] =
  [
    ["omp", ["OMPCODE"]],
    ["codex", ["CODEX_THREAD_ID", "CODEX_SANDBOX"]],
    ["gemini", ["GEMINI_CLI"]],
    ["opencode", ["OPENCODE"]],
    ["cursor", ["CURSOR_AGENT"]],
    ["copilot", ["COPILOT_AGENT", "COPILOT_CLI"]],
    ["junie", ["JUNIE_DATA"]],
    ["auggie", ["AUGMENT_AGENT"]],
    ["goose", ["GOOSE_PROVIDER"]],
    ["replit", ["REPL_ID"]],
  ];

export const isSet = (value: string | undefined): boolean =>
  value !== undefined &&
  value.trim() !== "" &&
  value !== "0" &&
  value !== "false";

/**
 * The caller, most explicit signal first:
 * 1. `GROKBOT_CLIENT`, set by the owner;
 * 2. the MCP client's own name, when called over MCP;
 * 3. the nearest runtime on the process chain (`process codex`): a runtime started inside
 *    another inherits the outer one's environment, but is itself the nearest process;
 * 4. `AI_AGENT`, the convention agent runtimes share;
 * 5. the marker only one runtime sets (OMPCODE, CODEX_THREAD_ID, GEMINI_CLI, ...);
 * 6. markers other runtimes imitate, last: CLAUDE_CODE_ENTRYPOINT ("claude-desktop" in the
 *    desktop app), CLAUDECODE, CLAUDE_CODE;
 * 7. a terminal on stdin (a person) or none (a script).
 * Claude Code's own name folds into "claude-desktop" inside the desktop app, so one actor
 * counts once.
 */
export function detectClient({
  env,
  isTTY,
  mcpClientName,
  processChain,
}: ClientSignals): DetectedClient {
  // Read at most once, and only when a signal needs it.
  let entrypoint: string | undefined;
  let entrypointRead = false;
  const entrypointOf = () => {
    if (!entrypointRead) {
      entrypoint = env.CLAUDE_CODE_ENTRYPOINT?.trim();
      entrypointRead = true;
    }
    return entrypoint;
  };
  const folded = (label: ClientLabel): ClientLabel =>
    label === "claude-code" && entrypointOf() === "claude-desktop"
      ? "claude-desktop"
      : label;
  const named = (name: string, signal: string): DetectedClient => ({
    label: folded(labelForName(name)),
    signal,
  });

  const explicit = env.GROKBOT_CLIENT?.trim();
  if (explicit) {
    return {
      label: isClientLabel(explicit) ? explicit : labelForName(explicit),
      signal: "GROKBOT_CLIENT",
    };
  }
  if (mcpClientName?.trim()) return named(mcpClientName, "MCP client");
  for (const name of processChain()) {
    const label = Object.hasOwn(PROCESS_RUNTIMES, name)
      ? PROCESS_RUNTIMES[name]
      : undefined;
    if (label !== undefined) {
      return { label: folded(label), signal: `process ${name}` };
    }
  }
  const agent = env.AI_AGENT?.trim();
  if (agent) return named(agent, "AI_AGENT");
  for (const [label, signals] of RUNTIME_MARKERS) {
    for (const signal of signals) {
      if (isSet(env[signal])) return { label, signal };
    }
  }
  if (env.PATH?.includes(".pi/agent")) return { label: "pi", signal: "PATH" };
  if (entrypointOf() === "claude-desktop") {
    return { label: "claude-desktop", signal: "CLAUDE_CODE_ENTRYPOINT" };
  }
  if (isSet(entrypointOf())) {
    return { label: "claude-code", signal: "CLAUDE_CODE_ENTRYPOINT" };
  }
  for (const signal of ["CLAUDECODE", "CLAUDE_CODE"]) {
    if (isSet(env[signal])) return { label: "claude-code", signal };
  }
  return isTTY
    ? { label: "human", signal: "terminal on stdin" }
    : { label: "script", signal: "no terminal on stdin" };
}
