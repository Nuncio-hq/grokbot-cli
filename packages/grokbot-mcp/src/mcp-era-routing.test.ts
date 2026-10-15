import { describe, expect, it } from "vitest";
import {
  ACCEPTED_VERSIONS,
  AGENTS_OUTPUT,
  AGENTS_TEXT,
  byId,
  DISCOVER_RESULT,
  initializeResult,
  legacyRequest,
  MODERN_META,
  modernRequest,
} from "./fixtures/mcp-era-requests.js";
import { exchange, fakeRunner, unusedRunner } from "./fixtures/mcp-session.js";

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

const invalidMeta = (id: number, detail: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32602, message: `Invalid params: _meta ${detail}` },
});

const unsupported = (id: number, requested: string) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: ACCEPTED_VERSIONS, requested },
  },
});

describe("grokbot-mcp era routing", () => {
  it("rejects a request whose _meta lacks or mistypes a required field", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve(AGENTS_OUTPUT));
    const messages = await exchange(
      runner,
      modernRequest(
        6,
        "tools/call",
        { name: "grokbot_agents" },
        { [VERSION_KEY]: "2026-07-28" },
      ),
      modernRequest(
        7,
        "server/discover",
        {},
        { [VERSION_KEY]: "2026-07-28", [CAPABILITIES_KEY]: null },
      ),
      modernRequest(
        12,
        "tools/list",
        {},
        {
          ...MODERN_META,
          [VERSION_KEY]: 20260728,
        },
      ),
    );
    expect(calls).toEqual([]);
    expect(byId(messages)).toEqual({
      6: invalidMeta(6, `${CAPABILITIES_KEY} is required`),
      7: invalidMeta(7, `${CAPABILITIES_KEY} must be an object`),
      12: invalidMeta(12, `${VERSION_KEY} must be a string`),
    });
  });

  it("answers an unsupported version with -32022 and the versions it accepts", async () => {
    const meta = (version: string) => ({
      ...MODERN_META,
      [VERSION_KEY]: version,
    });
    const messages = await exchange(
      unusedRunner,
      modernRequest(8, "server/discover", {}, meta("2099-01-01")),
      modernRequest(9, "tools/list", {}, meta("2025-11-25")),
    );
    expect(byId(messages)).toEqual({
      8: unsupported(8, "2099-01-01"),
      9: unsupported(9, "2025-11-25"),
    });
  });

  it("checks the version before fields a newer revision may define differently", async () => {
    const messages = await exchange(
      unusedRunner,
      modernRequest(13, "server/discover", {}, { [VERSION_KEY]: "2099-01-01" }),
    );
    expect(messages).toEqual([unsupported(13, "2099-01-01")]);
  });

  it("serves a client that never sends the version key exactly as before", async () => {
    const { runner } = fakeRunner(() => Promise.resolve(AGENTS_OUTPUT));
    const messages = await exchange(
      runner,
      legacyRequest(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "0.0.0" },
      }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      legacyRequest(2, "tools/call", {
        name: "grokbot_agents",
        _meta: { progressToken: "p" },
      }),
      legacyRequest(3, "server/discover"),
    );
    expect(byId(messages)).toEqual({
      1: { jsonrpc: "2.0", id: 1, result: initializeResult("2025-11-25") },
      2: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: AGENTS_TEXT }],
          structuredContent: AGENTS_OUTPUT,
        },
      },
      3: {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32601, message: "Method not found: server/discover" },
      },
    });
  });

  it("serves both eras interleaved on one connection, each by its own rules", async () => {
    const messages = await exchange(
      unusedRunner,
      modernRequest("m1", "server/discover"),
      legacyRequest("l1", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "0.0.0" },
      }),
      modernRequest("m2", "ping"),
      legacyRequest("l2", "ping"),
      modernRequest("m3", "initialize", { protocolVersion: "2025-06-18" }),
    );
    expect(byId(messages)).toEqual({
      m1: { jsonrpc: "2.0", id: "m1", result: DISCOVER_RESULT },
      l1: { jsonrpc: "2.0", id: "l1", result: initializeResult("2025-06-18") },
      m2: {
        jsonrpc: "2.0",
        id: "m2",
        error: { code: -32601, message: "Method not found: ping" },
      },
      l2: { jsonrpc: "2.0", id: "l2", result: {} },
      m3: {
        jsonrpc: "2.0",
        id: "m3",
        error: { code: -32601, message: "Method not found: initialize" },
      },
    });
  });
});
