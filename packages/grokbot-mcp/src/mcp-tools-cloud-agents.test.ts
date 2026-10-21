import type { CommandOutputs } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { exchange, fakeRunner } from "./fixtures/mcp-session.js";
import { mcpTools } from "./mcp-tools.js";
import { summarize } from "./tool-summaries.js";

const BC = "bc-00000000-0000-4000-8000-0000000000a1";
const REPO = "https://example.test/acme/widgets";
type Summary = CommandOutputs["cloud-agents"]["cloudAgents"][number];
type Detail = CommandOutputs["cloud-agent"]["cloudAgent"];

const summary = (over: Partial<Summary> = {}): Summary => ({
  bcId: BC,
  name: "Fix the flaky test",
  status: "finished",
  repo: REPO,
  branch: "cursor/fix-flaky",
  prStatus: "merged",
  prUrl: `${REPO}/pull/7`,
  updatedAtMs: 1_790_000_000_000,
  createdAtMs: null,
  lastActivityAtMs: null,
  needsYou: false,
  ...over,
});
const detail = (over: Partial<Detail> = {}): Detail => ({
  ...summary(),
  baseBranch: "main",
  linesAdded: 120,
  linesRemoved: 8,
  filesChanged: 5,
  model: { name: "example-model", maxMode: false },
  source: "grok_bot",
  ...over,
});
const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const tool = (name: string) => mcpTools().find((t) => t.name === name);

describe("cloud agent MCP tools", () => {
  it("offers both commands as read-only tools, with no json flag", () => {
    expect(
      ["grokbot_cloud_agents", "grokbot_cloud_agent"].map((name) => [
        name,
        tool(name)?.annotations,
        Object.keys(tool(name)?.inputSchema.properties ?? {}),
      ]),
    ).toEqual([
      [
        "grokbot_cloud_agents",
        { readOnlyHint: true, destructiveHint: false },
        ["limit", "agent"],
      ],
      [
        "grokbot_cloud_agent",
        { readOnlyHint: true, destructiveHint: false },
        ["bcId", "messages", "wait", "timeout"],
      ],
    ]);
    expect(tool("grokbot_cloud_agent")?.inputSchema.required).toEqual(["bcId"]);
  });

  it("bounds the wait to 45 s by default, like grokbot_wait, and says how to keep waiting", () => {
    const schema = tool("grokbot_cloud_agent")?.inputSchema.properties;
    expect(schema?.timeout).toMatchObject({ type: "integer", default: 45 });
    expect(tool("grokbot_cloud_agent")?.description).toContain(
      'outcome.status "pending", so call it again to keep waiting',
    );
  });

  it("says that a wait can end because the agent needs the owner", () => {
    expect(tool("grokbot_cloud_agent")?.description).toContain(
      'outcome.status "needs-you"',
    );
  });

  it("hands a needs-you outcome back as typed output beside the text", async () => {
    const outcome = {
      status: "needs-you",
      reason: "waiting for your input",
    };
    const output = {
      cloudAgent: detail({ status: "running", needsYou: true }),
      messages: [],
      messageCount: 0,
      outcome,
    };
    const { runner } = fakeRunner(() => Promise.resolve(output));
    const [message] = (await exchange(
      runner,
      call(1, "grokbot_cloud_agent", { bcId: BC, wait: true }),
    )) as {
      result: { structuredContent: { outcome: unknown }; isError?: true };
    }[];
    expect(message?.result.structuredContent.outcome).toEqual(outcome);
    expect(message?.result.isError).toBeUndefined();
  });

  it("runs a wait with the 45 s bound when the client leaves the timeout out, and keeps one it sets", async () => {
    const output = {
      cloudAgent: detail({ status: "running" }),
      messages: [],
      messageCount: 0,
      outcome: { status: "pending", reason: "still running after 45 s" },
    };
    const { runner, calls } = fakeRunner(() => Promise.resolve(output));
    const messages = await exchange(
      runner,
      call(1, "grokbot_cloud_agent", { bcId: BC, wait: true }),
      call(2, "grokbot_cloud_agent", { bcId: BC, wait: true, timeout: 300 }),
      call(3, "grokbot_cloud_agent", { bcId: BC, timeout: "" }),
    );
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      [
        "cloud-agent",
        { bcId: BC, messages: 10, wait: true, timeout: 45, json: false },
      ],
      [
        "cloud-agent",
        { bcId: BC, messages: 10, wait: true, timeout: 300, json: false },
      ],
      [
        "cloud-agent",
        { bcId: BC, messages: 10, wait: false, timeout: 45, json: false },
      ],
    ]);
    expect(messages).toHaveLength(3);
  });

  it("returns the typed output beside the text, and passes the list filters on", async () => {
    const output = {
      cloudAgents: [summary()],
      hasMore: false,
      launchedBy: { agentId: "a-1", name: "Primary Test" },
    };
    const { runner, calls } = fakeRunner(() => Promise.resolve(output));
    const [message] = (await exchange(
      runner,
      call(1, "grokbot_cloud_agents", { limit: 3, agent: "Primary Test" }),
    )) as { result: { structuredContent: unknown; isError?: true } }[];
    expect(calls[0]?.input).toEqual({
      limit: 3,
      agent: "Primary Test",
      json: false,
    });
    expect(message?.result.structuredContent).toEqual(output);
    expect(message?.result.isError).toBeUndefined();
  });

  it("refuses a limit below 1 without running the command", async () => {
    const { runner, calls } = fakeRunner(() => Promise.resolve({}));
    const [message] = (await exchange(
      runner,
      call(1, "grokbot_cloud_agents", { limit: 0 }),
    )) as { result: { isError?: true } }[];
    expect([calls, message?.result.isError]).toEqual([[], true]);
  });
});

describe("cloud agent summaries", () => {
  it("lists each agent on one line, naming the bot filter and a truncated list", () => {
    expect(
      summarize("cloud-agents", {
        cloudAgents: [
          summary(),
          summary({
            bcId: "bc-b2",
            name: "",
            status: "running",
            repo: "",
            prStatus: null,
          }),
        ],
        hasMore: true,
        launchedBy: { agentId: "a-1", name: "Primary Test" },
      }),
    ).toBe(
      [
        "2 cloud agents launched by Primary Test (more exist: raise limit):",
        `- ${BC} finished: Fix the flaky test (${REPO} cursor/fix-flaky) PR merged`,
        "- bc-b2 running: (unnamed)",
      ].join("\n"),
    );
  });

  it("says so when nothing matches", () => {
    expect(
      summarize("cloud-agents", {
        cloudAgents: [],
        hasMore: false,
        launchedBy: null,
      }),
    ).toBe("0 cloud agents:");
  });

  it("shows the status, repo, pull request and the messages with their roles", () => {
    expect(
      summarize("cloud-agent", {
        cloudAgent: detail(),
        messages: [
          { id: "b1", role: "human", text: "Fix it\n" },
          { id: "b2", role: "assistant", text: "Done." },
        ],
        messageCount: 5,
      }),
    ).toBe(
      [
        `Fix the flaky test (${BC}): finished`,
        `repo ${REPO} on cursor/fix-flaky`,
        `PR merged ${REPO}/pull/7`,
        "2 of 5 messages:",
        "human: Fix it",
        "assistant: Done.",
      ].join("\n"),
    );
  });

  it("tells a caller that a timed-out wait can be resumed, and omits what is absent", () => {
    expect(
      summarize("cloud-agent", {
        cloudAgent: detail({
          name: "",
          status: "running",
          repo: "",
          prStatus: null,
          prUrl: "",
        }),
        messages: [],
        messageCount: null,
        outcome: { status: "pending", reason: "still running after 45 s" },
      }),
    ).toBe(
      `(unnamed) (${BC}): running (still running after 45 s; call again to keep waiting)`,
    );
  });

  it("tells a caller that an agent waits on the owner, and for what, in the text of a wait", () => {
    const text = summarize("cloud-agent", {
      cloudAgent: detail({ status: "running", needsYou: true }),
      messages: [],
      messageCount: null,
      outcome: {
        status: "needs-you",
        reason: "waiting for your approval (mcp_tool): Allow the deploy tool",
      },
    });
    expect(text).toContain(`(${BC}): running`);
    expect(text).toContain("Allow the deploy tool");
    expect(text).toContain("owner");
    // The reason is said once: the outcome carries it, so the flag adds no second note.
    expect(text.match(/needs you/g)).toBeNull();
  });

  it("marks an agent that waits on the owner in a plain read and in the list", () => {
    const waiting = detail({ needsYou: true });
    expect(
      summarize("cloud-agent", {
        cloudAgent: waiting,
        messages: [],
        messageCount: null,
      }),
    ).toContain("needs you");
    const listed = summarize("cloud-agents", {
      cloudAgents: [summary({ needsYou: true }), summary({ bcId: "bc-b2" })],
      hasMore: false,
      launchedBy: null,
    }).split("\n");
    expect([
      listed[1]?.includes("needs you"),
      listed[2]?.includes("needs you"),
    ]).toEqual([true, false]);
  });
});
