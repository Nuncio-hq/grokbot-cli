import { describe, expect, it, vi } from "vitest";
import {
  AGENTS_OUTPUT,
  AGENTS_TEXT,
  byId,
  DISCOVER_RESULT,
  legacyRequest,
  modernRequest,
  SERVER_META,
} from "./fixtures/mcp-era-requests.js";
import {
  exchange,
  fakeRunner,
  startSession,
  unusedRunner,
} from "./fixtures/mcp-session.js";

describe("grokbot-mcp 2026-07-28 results", () => {
  it("answers server/discover with versions, capabilities, identity, and cache hints", async () => {
    const messages = await exchange(
      unusedRunner,
      modernRequest("discover-1", "server/discover"),
    );
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: "discover-1", result: DISCOVER_RESULT },
    ]);
  });

  it("lists the legacy era's tools as a complete, cacheable result", async () => {
    const response = byId(
      await exchange(
        unusedRunner,
        legacyRequest(1, "tools/list"),
        modernRequest(2, "tools/list"),
      ),
    );
    const { tools, ...modern } = (
      response[2] as { result: { tools: { name: string }[] } }
    ).result;
    expect(tools[0]?.name).toBe("grokbot_agents");
    expect(modern).toEqual({
      resultType: "complete",
      ttlMs: 3_600_000,
      cacheScope: "public",
      _meta: SERVER_META,
    });
    expect(response[1]).toEqual({ jsonrpc: "2.0", id: 1, result: { tools } });
  });

  it("runs tools/call and marks results and tool errors complete", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve(AGENTS_OUTPUT));
    const messages = await exchange(
      runner,
      modernRequest(3, "tools/call", { name: "grokbot_agents" }),
      modernRequest(4, "tools/call", {
        name: "grokbot_ask",
        arguments: { timeout: 0 },
      }),
      modernRequest(5, "tools/call", { name: "grokbot_delete" }),
    );
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      ["agents", { json: false }],
    ]);
    expect(byId(messages)).toEqual({
      3: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: AGENTS_TEXT }],
          structuredContent: AGENTS_OUTPUT,
          _meta: SERVER_META,
        },
      },
      4: {
        jsonrpc: "2.0",
        id: 4,
        result: {
          resultType: "complete",
          content: [
            {
              type: "text",
              text: 'ask: missing required parameter "text"\nask: parameter "timeout" must be at least 1, got 0',
            },
          ],
          isError: true,
          _meta: SERVER_META,
        },
      },
      5: {
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32602, message: "Unknown tool: grokbot_delete" },
      },
    });
  });

  it("cancels a modern tools/call and never answers it", async () => {
    const { runner, calls } = fakeRunner(
      ({ signal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const session = startSession(runner);
    session.send(
      modernRequest(10, "tools/call", {
        name: "grokbot_wait",
        arguments: { job: "job-10" },
      }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    session.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 10, reason: "user pressed stop" },
    });
    await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
    session.send(modernRequest(11, "tools/list"));
    const messages = (await session.close()) as { id: unknown }[];
    expect(messages.map((m) => m.id)).toEqual([11]);
    expect(session.logs).toEqual(["cancelled request 10: user pressed stop"]);
  });
});
