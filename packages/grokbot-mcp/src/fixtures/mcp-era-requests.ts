import { GROKBOT_VERSION } from "grokbot-core";
import { PRIMARY_TEST } from "./mcp-session.js";

export const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "test-client",
    version: "0.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const SERVER_INFO = { name: "grokbot-mcp", version: GROKBOT_VERSION };

export const SERVER_META = {
  "io.modelcontextprotocol/serverInfo": SERVER_INFO,
};

export const ACCEPTED_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const DISCOVER_RESULT = {
  resultType: "complete",
  supportedVersions: ACCEPTED_VERSIONS,
  capabilities: { tools: {} },
  instructions:
    "Drives a GrokBot workforce: the AI agents on the owner's Grok Bot account. Start with grokbot_agents or grokbot_team to see who is available. Never pass yes: true without the owner's explicit approval.",
  ttlMs: 3_600_000,
  cacheScope: "public",
  _meta: SERVER_META,
};

export const initializeResult = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
});

export const AGENTS_OUTPUT = { agents: [PRIMARY_TEST] };
export const AGENTS_TEXT =
  "1 agent:\n- Primary Test (agent, f882ec52-17b1-4639-b0fc-07fed7526b09)";

/** A 2026-07-28 request: version and capabilities ride in every request's `_meta`. */
export function modernRequest(
  id: number | string,
  method: string,
  params: object = {},
  meta: object = MODERN_META,
) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } };
}

export function legacyRequest(
  id: number | string,
  method: string,
  params?: object,
) {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

/** Responses keyed by id, since async handlers may answer out of order. */
export function byId(messages: readonly unknown[]): Record<string, unknown> {
  return Object.fromEntries(
    messages.map((message) => [(message as { id: unknown }).id, message]),
  );
}
