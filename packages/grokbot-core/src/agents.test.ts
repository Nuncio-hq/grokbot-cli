import { describe, expect, it } from "vitest";
import {
  type Agent,
  listAgents,
  parseListAgentsResponse,
  pickAgentQuery,
  resolveAgent,
} from "./agents.js";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";

const GROK = "0a1b2c3d-1111-4111-8111-111111111111";
const PRIMARY = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const STAFF = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";
const ROOM = "5ca1ab1e-0000-4000-8000-000000000001";
const DEV1 = "d0d0d0d0-0000-4000-8000-000000000001";
const DEV2 = "d0d0d0d0-0000-4000-8000-000000000002";
const OTHER = "abcdef01-0000-4000-8000-000000000009";

const bot = (
  agentId: string,
  id: string,
  name: string,
  extra: JsonObject = {},
) => ({
  id,
  legacyAgentId: agentId,
  agentId,
  name,
  harness: "temporal",
  visibility: "GROK_BOT_AGENT_VISIBILITY_OWNER",
  kind: "GROK_BOT_AGENT_KIND_AGENT",
  viewerIsOwner: true,
  createdAtMs: "1791900000000",
  ...extra,
});

const WIRE = {
  agents: [
    bot(GROK, "12752009", "Grok Bot", { description: "Main assistant" }),
    bot(PRIMARY, "12928587", "Primary Test", {
      title: "Test bot",
      description: "Synthetic",
    }),
    bot(STAFF, "12928635", "Staff Test", { title: "Test bot" }),
    {
      id: "13000001",
      agentId: ROOM,
      name: "Design Room",
      kind: "GROK_BOT_AGENT_KIND_ROOM",
      memberAgentIds: [PRIMARY, STAFF.toUpperCase()],
    },
    bot(DEV1, "13000002", "Test-Dev-1"),
    bot(DEV2, "13000003", "Test-Dev-2"),
  ],
  slackConnections: [],
};

const AGENTS = parseListAgentsResponse(WIRE);
const NAMES =
  "Grok Bot, Primary Test, Staff Test, Design Room, Test-Dev-1, Test-Dev-2";

function thrown(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GrokBotError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a GrokBotError");
}

const found = (agent: Agent) => [agent.name, agent.agentId];

describe("listAgents", () => {
  it("calls ListGrokBotAgents with an empty body and parses bots and rooms", async () => {
    const calls: [string, JsonObject][] = [];
    const server: ServerTransport = {
      call: (method, body) => {
        calls.push([method, body]);
        return Promise.resolve(WIRE);
      },
      stream: () => {
        throw new Error("stream is not used");
      },
    };

    const agents = await listAgents(server);

    expect(calls).toStrictEqual([["ListGrokBotAgents", {}]]);
    expect(agents.slice(1, 4)).toStrictEqual([
      {
        kind: "agent",
        agentId: PRIMARY,
        rowId: "12928587",
        name: "Primary Test",
        title: "Test bot",
        description: "Synthetic",
        harness: "temporal",
      },
      {
        kind: "agent",
        agentId: STAFF,
        rowId: "12928635",
        name: "Staff Test",
        title: "Test bot",
        description: "",
        harness: "temporal",
      },
      {
        kind: "room",
        agentId: ROOM,
        rowId: "13000001",
        name: "Design Room",
        title: "",
        description: "",
        harness: "",
        memberAgentIds: [PRIMARY, STAFF],
      },
    ]);
  });

  it("reads an account with no bots, where the server omits the list", () => {
    expect(parseListAgentsResponse({ slackConnections: [] })).toStrictEqual([]);
  });

  it("rejects rows that break the wire contract", () => {
    expect(
      thrown(() =>
        parseListAgentsResponse({ agents: [bot("Primary Test", "1", "x")] }),
      ),
    ).toStrictEqual({
      code: "protocol",
      message: "ListGrokBotAgents: agents[0].agentId is not a UUID",
    });
    expect(
      thrown(() =>
        parseListAgentsResponse({
          agents: [bot(PRIMARY, "1", "x", { kind: "GROK_BOT_AGENT_KIND_X" })],
        }),
      ),
    ).toStrictEqual({
      code: "protocol",
      message:
        'ListGrokBotAgents: agents[0].kind "GROK_BOT_AGENT_KIND_X" is unknown',
    });
    expect(
      thrown(() =>
        parseListAgentsResponse({ agents: [bot(PRIMARY, "", "x")] }),
      ),
    ).toStrictEqual({
      code: "protocol",
      message: "ListGrokBotAgents: agents[0].id is not a numeric string",
    });
  });
});

describe("resolveAgent", () => {
  it.each([
    ["Primary Test", ["Primary Test", PRIMARY]],
    ["  primary test ", ["Primary Test", PRIMARY]],
    ["primary-test", ["Primary Test", PRIMARY]],
    ["Staff-Test", ["Staff Test", STAFF]],
    [STAFF.toUpperCase(), ["Staff Test", STAFF]],
    ["f882ec52", ["Primary Test", PRIMARY]],
    ["design room", ["Design Room", ROOM]],
  ])("resolves %j", (query, expected) => {
    expect(found(resolveAgent(query, AGENTS))).toStrictEqual(expected);
  });

  it("prefers an exact name over another agent's slug", () => {
    const agents = parseListAgentsResponse({
      agents: [...WIRE.agents, bot(OTHER, "9", "primary-test")],
    });
    expect(found(resolveAgent("primary-test", agents))).toStrictEqual([
      "primary-test",
      OTHER,
    ]);
    expect(found(resolveAgent("Primary Test", agents))).toStrictEqual([
      "Primary Test",
      PRIMARY,
    ]);
  });

  it("folds Vietnamese accents when matching a slug", () => {
    const agents = parseListAgentsResponse({
      agents: [bot(DEV1, "1", "Nhân Viên Đức")],
    });
    expect(found(resolveAgent("nhan-vien-duc", agents))).toStrictEqual([
      "Nhân Viên Đức",
      DEV1,
    ]);
  });

  it("refuses to guess between agents that share an agentId prefix", () => {
    expect(thrown(() => resolveAgent("d0d0d0d0", AGENTS))).toStrictEqual({
      code: "ambiguous",
      message: `"d0d0d0d0" matches 2 agents: Test-Dev-1 (${DEV1}), Test-Dev-2 (${DEV2}). Pass the full agentId.`,
    });
  });

  it("refuses to guess between agents that share a slug", () => {
    const agents = parseListAgentsResponse({
      agents: [...WIRE.agents, bot(OTHER, "9", "test dev 1")],
    });
    expect(thrown(() => resolveAgent("TEST_DEV_1", agents))).toStrictEqual({
      code: "ambiguous",
      message: `"TEST_DEV_1" matches 2 agents: Test-Dev-1 (${DEV1}), test dev 1 (${OTHER}). Pass the full agentId.`,
    });
  });

  it("lists the available names when nothing matches", () => {
    expect(thrown(() => resolveAgent("Test-Dev", AGENTS))).toStrictEqual({
      code: "not-found",
      message: `No agent matches "Test-Dev". Available agents: ${NAMES}.`,
    });
    expect(thrown(() => resolveAgent("f882ec5", AGENTS))).toStrictEqual({
      code: "not-found",
      message: `No agent matches "f882ec5". Available agents: ${NAMES}.`,
    });
    expect(thrown(() => resolveAgent("Primary Test", []))).toStrictEqual({
      code: "not-found",
      message: 'No agent matches "Primary Test". This account has no agents.',
    });
  });

  it("treats a blank query as no agent selected", () => {
    expect(thrown(() => resolveAgent("  ", AGENTS))).toStrictEqual({
      code: "not-found",
      message:
        "No agent selected. Pass --agent <name|agentId> or set GROKBOT_AGENT.",
    });
  });
});

describe("pickAgentQuery", () => {
  it("takes the --agent flag over GROKBOT_AGENT", () => {
    expect(
      pickAgentQuery({ flag: " Staff Test ", env: "Primary Test" }),
    ).toStrictEqual({ ok: true, query: "Staff Test" });
  });

  it("falls back to GROKBOT_AGENT when the flag is blank", () => {
    expect(pickAgentQuery({ flag: "  ", env: "Primary Test" })).toStrictEqual({
      ok: true,
      query: "Primary Test",
    });
  });

  it("never defaults to the first listed bot", () => {
    const picked = pickAgentQuery({ env: "" });
    expect(picked.ok).toBe(false);
    if (picked.ok) return;
    expect([picked.error.code, picked.error.message]).toStrictEqual([
      "not-found",
      "No agent selected. Pass --agent <name|agentId> or set GROKBOT_AGENT.",
    ]);
  });
});
