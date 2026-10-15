import { GrokBotError } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/** A computer registered to the account, from ListGrokBotUserComputers. */
export interface UserComputer {
  readonly machineId: string;
  readonly label: string;
  readonly kind: string;
  /** int64 ms as a decimal string, 0 when the server omits it. */
  readonly lastSeenAtMs: string;
  /** Capability flags the box advertised, true-valued, sorted. */
  readonly capabilities: readonly string[];
}

function readMsString(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return "0";
}

/** Parses a ListGrokBotUserComputers response; throws GrokBotError("protocol") on a break. */
export function parseUserComputers(raw: unknown): readonly UserComputer[] {
  const root = asJsonObject(raw);
  if (!root) {
    throw new GrokBotError(
      "protocol",
      "ListGrokBotUserComputers: not an object",
    );
  }
  const rows = Array.isArray(root.computers) ? root.computers : [];
  return rows.map((row) => {
    const o = asJsonObject(row) ?? {};
    const hello = asJsonObject(o.hello) ?? {};
    const capabilities = asJsonObject(hello.capabilities) ?? {};
    return {
      machineId: readString(o, "machineId") ?? "",
      label: readString(hello, "label") ?? "",
      kind: readString(hello, "kind") ?? "",
      lastSeenAtMs: readMsString(o.lastSeenAtMs),
      capabilities: Object.entries(capabilities)
        .filter(([, value]) => value === true)
        .map(([name]) => name)
        .sort(),
    };
  });
}

/** One MCP server as the Box gateway's getMcpState reports it for display. */
export interface McpServer {
  readonly name: string;
  readonly serverIdentifier: string;
  readonly transport: string;
  readonly toolCount: number;
  readonly disabledToolCount: number;
  readonly status: string;
  readonly isTeamServer: boolean;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parses a Box gateway getMcpState response. The app returns `{ servers: [...] }`
 * (REA fct `listServersForDisplay`/`summarizeServers`); each summary carries name,
 * serverIdentifier, transport, toolCount, disabledToolCount, status, isTeamServer.
 */
export function parseMcpState(raw: unknown): readonly McpServer[] {
  const rows = asJsonObject(raw)?.servers;
  if (!Array.isArray(rows)) {
    throw new GrokBotError(
      "protocol",
      "getMcpState: the reply has no servers list.",
    );
  }
  return rows.map((row) => {
    const o = asJsonObject(row) ?? {};
    return {
      name: readString(o, "name") ?? "",
      serverIdentifier: readString(o, "serverIdentifier") ?? "",
      transport: readString(o, "transport") ?? "",
      toolCount: readCount(o.toolCount),
      disabledToolCount: readCount(o.disabledToolCount),
      status: readString(o, "status") ?? "",
      isTeamServer: o.isTeamServer === true,
    };
  });
}

const TOKEN_LIKE = [
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/** Replaces JWTs, long hex, and long opaque strings with [redacted]. */
export function redactTokenLike(text: string): string {
  return TOKEN_LIKE.reduce(
    (out, pattern) => out.replace(pattern, "[redacted]"),
    text,
  );
}

/** The outcome of a Box MCP tool call, with no token-like content printed by callers. */
export interface McpCallResult {
  /** A best-effort text rendering of the tool's result. */
  readonly text: string;
  /** Top-level keys of the structured result, for a safe one-line summary. */
  readonly topLevelKeys: readonly string[];
  readonly isError: boolean;
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => readString(asJsonObject(item) ?? {}, "text"))
    .filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Parses a callMcpAppTool response into a printable view. The text is MCP `content[].text`
 * when present, else the JSON; token-like strings are redacted either way.
 *
 * A tool that needs a real click answers `{ code: "needs_activation" }` (REA: the app's
 * MCP-app bridge `settle()` checks this, v0.70.2). grokbot never claims one, so it stops.
 */
export function parseMcpCallResult(
  raw: unknown,
  tool: { readonly server: string; readonly tool: string },
): McpCallResult {
  const root = asJsonObject(raw);
  if (root?.code === "needs_activation") {
    throw new GrokBotError(
      "safety",
      `${tool.server}/${tool.tool} needs a click in the Grok Bot app, so grokbot cannot run it. Run it from the app instead.`,
    );
  }
  if (!root) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    return { text: redactTokenLike(text), topLevelKeys: [], isError: false };
  }
  const text = textFromContent(root.content) ?? JSON.stringify(root, null, 2);
  return {
    text: redactTokenLike(text),
    topLevelKeys: Object.keys(root).sort(),
    isError: root.isError === true,
  };
}
