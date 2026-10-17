import { Buffer } from "node:buffer";
import {
  type CommandOutputs,
  createCommandRunner,
  type ServerTransport,
} from "grokbot-core";
import { describe, expect, it } from "vitest";
import {
  exchange,
  PRIMARY_TEST,
  unusedRunner,
} from "./fixtures/mcp-session.js";
import { mcpTools } from "./mcp-tools.js";
import { summarize } from "./tool-summaries.js";

type Card = CommandOutputs["approvals"]["agents"][number]["cards"][number];
const WIDGET: Card = {
  entryId: "t2s0",
  seq: "6" as Card["seq"],
  type: "widget",
  prompt: "Pick a color",
  options: ["Red", "Blue"],
};
const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

/** A pending phone-call auto-review row, shaped like the app's transcript. */
function phoneCallRow() {
  const body = {
    kind: "send-message",
    id: "t8",
    message: {
      type: "auto-review-approval",
      approval: {
        requestId: "ar-phone",
        status: "pending",
        summary: "place_phone_call",
        summaryCopy: {
          kind: "phone_call",
          params: { destination: "+1 555 0100", request: "Book a table for 2" },
        },
      },
    },
    requestId: "req-phone",
    timestampMs: 1,
  };
  return {
    seq: "8",
    updatedSeq: "8",
    entryId: "entry-8",
    entryKind: "send-message",
    body: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
  };
}

/** The real command runner over a fake server, so approve hits the safety check. */
function phoneCallRunner() {
  const methods: string[] = [];
  const server: ServerTransport = {
    async call(method) {
      methods.push(method);
      if (method === "ListGrokBotAgents") {
        return {
          agents: [
            {
              id: "1",
              agentId: PRIMARY_TEST.agentId,
              name: PRIMARY_TEST.name,
              kind: "GROK_BOT_AGENT_KIND_AGENT",
            },
          ],
        };
      }
      if (method === "ListGrokBotTranscriptEntries") {
        return { entries: [phoneCallRow()] };
      }
      throw new Error(`unexpected RPC ${method}`);
    },
    stream() {
      throw new Error("no stream");
    },
  };
  return {
    runner: createCommandRunner({
      server,
      gateway: {
        async call() {
          throw new Error("gateway must not be called");
        },
      },
    }),
    methods,
  };
}

describe("governance MCP tools", () => {
  it("exposes hyphenated commands as grokbot_ tools with safety annotations", () => {
    const byName = new Map(mcpTools().map((tool) => [tool.name, tool]));
    expect(
      [
        "grokbot_approvals",
        "grokbot_answer",
        "grokbot_approve",
        "grokbot_mcp_list",
        "grokbot_mcp_call",
        "grokbot_vnc",
        "grokbot_worker_plan",
        "grokbot_worker_start",
      ].map((name) => [name, byName.get(name)?.annotations]),
    ).toEqual([
      ["grokbot_approvals", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_answer", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_approve", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_mcp_list", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_mcp_call", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_vnc", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_worker_plan", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_worker_start", undefined],
    ]);
  });

  it("offers vnc without print-url and refuses it before running anything", async () => {
    const vnc = mcpTools().find((tool) => tool.name === "grokbot_vnc");
    const messages = await exchange(
      unusedRunner,
      call(1, "grokbot_vnc", { window: 3, "print-url": true }),
    );
    expect([Object.keys(vnc?.inputSchema.properties ?? {}), messages]).toEqual([
      ["window"],
      [
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: "grokbot_vnc: print-url cannot be set over MCP; use the grokbot CLI.",
              },
            ],
            isError: true,
          },
        },
      ],
    ]);
  });

  it("returns an error when grokbot_approve is asked to allow a phone call", async () => {
    const { runner, methods } = phoneCallRunner();
    const [response] = await exchange(
      runner,
      call(1, "grokbot_approve", { agent: "Primary Test", yes: true }),
    );
    expect([
      (response as { result: object }).result,
      methods.includes("ResolveGrokBotAutoReviewApproval"),
    ]).toEqual([
      {
        content: [
          {
            type: "text",
            text: "Phone call to +1 555 0100: Book a table for 2: only the owner can answer this in the GrokBot app.",
          },
        ],
        isError: true,
      },
      false,
    ]);
  });

  it("keeps worker-start off MCP, since the worker writes to the JSON-RPC pipe", async () => {
    const messages = await exchange(
      unusedRunner,
      call(1, "grokbot_worker_start", { yes: true }),
    );
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Unknown tool: grokbot_worker_start" },
      },
    ]);
  });

  it("summarizes open cards, an answer, a worker dry run, and an opened desktop", () => {
    expect([
      summarize("approvals", {
        agents: [
          {
            agent: PRIMARY_TEST,
            awaiting: null,
            handoff: null,
            cards: [WIDGET],
          },
        ],
      }),
      summarize("answer", {
        agent: PRIMARY_TEST,
        card: WIDGET,
        dismissed: false,
        value: "Blue",
      }),
      summarize("worker-plan", {
        registered: [],
        plan: {
          command: ["cursor-agent", "worker", "start"],
          envNames: ["HOME"],
        },
      }),
      summarize("vnc", { window: 3, opened: true, url: undefined }),
      summarize("approvals", {
        agents: [
          {
            agent: PRIMARY_TEST,
            awaiting: null,
            handoff: { requestId: "h-1", instruction: "Sign in to Xero" },
            cards: [
              {
                entryId: "t9s0",
                seq: "12" as (typeof WIDGET)["seq"],
                type: "credential-request",
                summary: "Use a saved login for bank.example.com",
              },
            ],
          },
          {
            agent: PRIMARY_TEST,
            awaiting: "Hand-off",
            handoff: null,
            cards: [],
          },
        ],
      }),
    ]).toEqual([
      "- Primary Test: widget t2s0: Pick a color [Red | Blue]",
      'Accepted: answered widget t2s0 on Primary Test with "Blue".',
      "Nothing started. Command:\ncursor-agent worker start\nenv: HOME\nRegistered computers now: none.",
      "Opened desktop window 3 on the host.",
      "- Primary Test: box-handoff h-1: Take over the bot's computer: Sign in to Xero (only the owner can answer this in the GrokBot app)\n" +
        "- Primary Test: credential-request t9s0: Use a saved login for bank.example.com (only the owner can answer this in the GrokBot app)\n" +
        "- Primary Test: awaiting Hand-off (no open card in the last 50 rows; check the bot in the GrokBot app)",
    ]);
  });
});
