import { GROKBOT_VERSION } from "grokbot-core";
import { describe, expect, it, vi } from "vitest";
import {
  exchange,
  fakeRunner,
  startSession,
  unusedRunner,
} from "./fixtures/mcp-session.js";

const initialize = (id: number, protocolVersion: string) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
});

describe("grokbot-mcp lifecycle", () => {
  it("echoes a supported protocol version and offers its own otherwise", async () => {
    const messages = await exchange(
      unusedRunner,
      initialize(1, "2025-06-18"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      initialize(2, "2026-07-28"),
    );
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "grokbot-mcp", version: GROKBOT_VERSION },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "grokbot-mcp", version: GROKBOT_VERSION },
        },
      },
    ]);
  });

  it("answers ping, rejects unknown methods, and ignores unknown notifications", async () => {
    const messages = await exchange(
      unusedRunner,
      { jsonrpc: "2.0", id: "p", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/whatever" },
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
    );
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: "p", result: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32601, message: "Method not found: resources/list" },
      },
    ]);
  });

  it("reports malformed JSON, invalid requests, and non-object params", async () => {
    const messages = await exchange(
      unusedRunner,
      '{"jsonrpc":"2.0","id":4,"method":',
      "[]",
      { jsonrpc: "1.0", id: 5, method: "ping" },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: [1] },
    );
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32600, message: "Invalid Request" },
      },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        error: {
          code: -32602,
          message: "Invalid params: params must be an object",
        },
      },
    ]);
  });
});

describe("grokbot-mcp tools/list", () => {
  it("renders every catalog command as a grokbot_ tool without the json param", async () => {
    const [response] = await exchange(unusedRunner, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const { tools } = (
      response as {
        result: { tools: { name: string; annotations: object }[] };
      }
    ).result;
    expect(tools.slice(0, 7).map((t) => t.name)).toEqual([
      "grokbot_agents",
      "grokbot_team",
      "grokbot_ask",
      "grokbot_send",
      "grokbot_wait",
      "grokbot_tail",
      "grokbot_interrupt",
    ]);
    expect(tools[0]).toEqual({
      name: "grokbot_agents",
      description: "List GrokBot agents on the account",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    const outcomes =
      '"done" means the bot\'s run for this message ended, not that the task is verified; "ambiguous" means one run answered this message together with another, and the result holds every reply of that run.';
    expect(tools[4]).toEqual({
      name: "grokbot_wait",
      description: `Wait for a dispatched job id to finish. Waits 45 s unless timeout is set, to stay under MCP host time limits; a still-running result carries the job id, so call grokbot_wait again with it. ${outcomes}`,
      inputSchema: {
        type: "object",
        properties: {
          job: { type: "string", description: "Job id returned by send" },
          timeout: {
            type: "integer",
            description: "Seconds to wait before giving up",
            default: 45,
            minimum: 1,
          },
        },
        required: ["job"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(tools[2]).toEqual({
      name: "grokbot_ask",
      description: `Send a prompt and wait until the Done Rule settles. Writes: changes state on a live GrokBot agent. Waits 45 s unless timeout is set; a still-running result carries a job id, and grokbot_wait resumes it. ${outcomes}`,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Message to send to the agent" },
          timeout: {
            type: "integer",
            description: "Seconds to wait before giving up",
            default: 45,
            minimum: 1,
          },
          agent: {
            type: "string",
            description:
              "Agent name, slug, or agentId (defaults to GROKBOT_AGENT)",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    expect(tools.slice(0, 7).map((t) => [t.name, t.annotations])).toEqual([
      ["grokbot_agents", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_team", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_ask", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_send", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_wait", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_tail", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_interrupt", { readOnlyHint: false, destructiveHint: true }],
    ]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(tools.every((t) => t.name.startsWith("grokbot_"))).toBe(true);
  });
});

describe("grokbot-mcp cancellation", () => {
  it("aborts the runner for a cancelled request and never answers it", async () => {
    const { runner, calls } = fakeRunner(
      ({ signal }) =>
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const session = startSession(runner);
    session.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "grokbot_wait", arguments: { job: "job-7" } },
    });
    session.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 99, reason: "unknown id is ignored" },
    });
    session.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "user pressed stop" },
    });
    await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
    session.send({ jsonrpc: "2.0", id: 8, method: "ping" });
    expect(await session.close()).toEqual([
      { jsonrpc: "2.0", id: 8, result: {} },
    ]);
    expect(calls.map((c) => [c.name, c.signal?.aborted])).toEqual([
      ["wait", true],
    ]);
    expect(session.logs).toEqual(["cancelled request 7: user pressed stop"]);
  });

  it("aborts in-flight calls and returns when stdin closes", async () => {
    const { runner, calls } = fakeRunner(
      ({ signal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const session = startSession(runner);
    session.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "grokbot_wait", arguments: { job: "job-1" } },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(await session.close()).toEqual([]);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});
