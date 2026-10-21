import {
  type CommandRunner,
  GROKBOT_VERSION,
  type JsonObject,
} from "grokbot-core";
import type { Outcome } from "./json-rpc.js";
import {
  type Era,
  LEGACY_VERSIONS,
  SUPPORTED_VERSIONS,
} from "./mcp-era-request.js";
import { callTool, mcpTools } from "./mcp-tools.js";

type Handler = (
  params: JsonObject,
  signal: AbortSignal,
) => Outcome | Promise<Outcome>;

const SERVER_INFO = { name: "grokbot-mcp", version: GROKBOT_VERSION };

const INSTRUCTIONS =
  "Drives a GrokBot workforce: the AI agents on the owner's Grok Bot account. Start with grokbot_agents or grokbot_team to see who is available. Never pass yes: true without the owner's explicit approval.";

/** Both results come from the catalog, so they are identical for every caller until an upgrade. */
const CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: "public" } as const;

function initialize(params: JsonObject): Outcome {
  const protocolVersion =
    LEGACY_VERSIONS.find((v) => v === params.protocolVersion) ??
    LEGACY_VERSIONS[0];
  return {
    result: {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    },
  };
}

/** 2026-07-28 results carry `resultType`, and serverInfo rides in `_meta` because there is no handshake. */
function complete(handler: Handler): Handler {
  return async (params, signal) => {
    const outcome = await handler(params, signal);
    if (!("result" in outcome)) return outcome;
    return {
      result: {
        resultType: "complete",
        ...outcome.result,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      },
    };
  };
}

/** Each era's methods. Modern drops initialize and ping and adds server/discover. */
export function eraHandlers(
  runner: CommandRunner,
): Readonly<Record<Era, ReadonlyMap<string, Handler>>> {
  const call: Handler = (params, signal) => callTool(params, runner, signal);
  return {
    legacy: new Map<string, Handler>([
      ["initialize", initialize],
      ["ping", () => ({ result: {} })],
      ["tools/list", () => ({ result: { tools: mcpTools() } })],
      ["tools/call", call],
    ]),
    modern: new Map<string, Handler>([
      [
        "server/discover",
        complete(() => ({
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
            ...CACHE_HINTS,
          },
        })),
      ],
      [
        "tools/list",
        complete(() => ({ result: { tools: mcpTools(), ...CACHE_HINTS } })),
      ],
      ["tools/call", complete(call)],
    ]),
  };
}
