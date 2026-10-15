import type { GovernanceOutputs } from "./command-outputs-governance.js";
import type { HandlerRun, RunnerContext } from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import type { GovernanceDeps } from "./governance-deps.js";
import {
  parseMcpCallResult,
  parseMcpState,
  parseUserComputers,
} from "./governance-listings.js";
import { vncViewerUrl } from "./governance-vnc.js";
import { asJsonObject } from "./transcript.js";

export async function listComputers(
  ctx: RunnerContext,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["computers"]> {
  const raw = await ctx.server.call("ListGrokBotUserComputers", {}, { signal });
  return { computers: parseUserComputers(raw) };
}

export async function listMcp(
  ctx: RunnerContext,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["mcp-list"]> {
  return {
    servers: parseMcpState(
      await ctx.gateway.call("getMcpState", {}, { signal }),
    ),
  };
}

function parseArgsJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GrokBotError(
      "not-found",
      "--args must be a JSON object, e.g. '{}'.",
    );
  }
  if (asJsonObject(parsed) === undefined) {
    throw new GrokBotError(
      "not-found",
      "--args must be a JSON object, e.g. '{}'.",
    );
  }
  return JSON.stringify(parsed);
}

/**
 * Calls one tool on a connected third-party MCP server with the owner's accounts, so it is
 * sensitive and runs only with --yes. `userActivated` stays false: no user clicked anything,
 * and a tool that insists on a click is refused rather than faked.
 */
export async function callMcp(
  ctx: RunnerContext,
  input: {
    readonly server: string;
    readonly tool: string;
    readonly args: string;
  },
  run: HandlerRun,
): Promise<GovernanceOutputs["mcp-call"]> {
  const argumentsJson = parseArgsJson(input.args);
  const raw = await ctx.gateway.call(
    "callMcpAppTool",
    {
      serverIdentifier: input.server,
      toolName: input.tool,
      argumentsJson,
      userActivated: false,
    },
    { signal: run.signal, confirmed: run.confirmed },
  );
  return {
    server: input.server,
    tool: input.tool,
    result: parseMcpCallResult(raw, input),
  };
}

export async function openVnc(
  ctx: RunnerContext,
  deps: GovernanceDeps,
  input: { readonly window: number; readonly "print-url": boolean },
  signal?: AbortSignal,
): Promise<GovernanceOutputs["vnc"]> {
  const raw = await ctx.server.call(
    "EnsureSandBoxWindow",
    { windowIndex: input.window },
    { signal },
  );
  const url = vncViewerUrl(raw);
  if (input["print-url"]) {
    return { window: input.window, opened: false, url };
  }
  // The opener's error repeats its argv, the credential URL included, so none of it is kept.
  const opened = await deps.openUrl(url).then(
    () => true,
    () => false,
  );
  if (!opened) {
    throw new GrokBotError(
      "protocol",
      "Could not open the VNC viewer (open failed). Re-run with --print-url in a terminal.",
    );
  }
  return { window: input.window, opened: true, url: undefined };
}
