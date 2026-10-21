import type { CommandOutputs } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { exchange, fakeRunner, PRIMARY_TEST } from "./fixtures/mcp-session.js";
import { mcpTools } from "./mcp-tools.js";
import { summarize } from "./tool-summaries.js";

const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const LIST: CommandOutputs["inbox"] = {
  scope: { kind: "all", source: "all" },
  computer: "example-mac",
  items: [
    {
      id: "bbbb2222",
      slug: "acme-web",
      state: "ok",
      kind: "bug",
      createdAt: "2026-10-20T11:00:00Z",
      ageSeconds: 3600,
      project: "Acme Web",
      severity: "critical",
      title: "Checkout fails",
      bot: { agentId: PRIMARY_TEST.agentId, name: "Primary Test" },
      blocking: true,
      yourTurnHere: true,
      forThisSession: false,
    },
  ],
  hiddenHandled: 0,
  hiddenExpired: 0,
  elsewhere: 0,
  projects: [],
};

describe("inbox tools", () => {
  it("offers the five inbox tools from the catalog, read-only unless they send", () => {
    const tools = new Map(mcpTools().map((t) => [t.name, t]));
    for (const name of [
      "grokbot_inbox",
      "grokbot_inbox_show",
      "grokbot_inbox_fetch",
      "grokbot_inbox_reply",
      "grokbot_inbox_done",
    ]) {
      expect(tools.has(name), name).toBe(true);
    }
    expect(tools.get("grokbot_inbox")?.annotations.readOnlyHint).toBe(true);
    expect(tools.get("grokbot_inbox_reply")?.annotations.readOnlyHint).toBe(
      false,
    );
    expect(tools.get("grokbot_inbox_done")?.annotations.readOnlyHint).toBe(
      false,
    );
  });

  it("never lets a model pick the folder inbox_fetch saves into", async () => {
    const fetchTool = mcpTools().find((t) => t.name === "grokbot_inbox_fetch");
    expect(Object.keys(fetchTool?.inputSchema.properties ?? {})).not.toContain(
      "out",
    );
    const { runner, calls } = fakeRunner(() => Promise.reject(new Error("no")));
    const [response] = await exchange(
      runner,
      call(1, "grokbot_inbox_fetch", { id: "aaaa1111", out: "/tmp/x" }),
    );
    expect(response).toMatchObject({ result: { isError: true } });
    expect(calls).toEqual([]);
  });

  it("runs the catalog command and answers with a summary and the typed output", async () => {
    const { runner, calls } = fakeRunner(async () => LIST);
    const [response] = await exchange(runner, call(1, "grokbot_inbox", {}));
    expect(calls).toMatchObject([
      { name: "inbox", input: { all: false, "include-handled": false } },
    ]);
    expect(response).toMatchObject({
      result: { structuredContent: LIST },
    });
    const text = (response as { result: { content: { text: string }[] } })
      .result.content[0]?.text;
    expect(text).toContain("bbbb2222");
    expect(text).toContain("Checkout fails");
  });

  it("summarizes a sent reply with its job id", () => {
    expect(
      summarize("inbox-reply", {
        id: "aaaa1111",
        jobId: "job-7",
        agent: PRIMARY_TEST,
        queued: false,
        action: "reply",
      }),
    ).toContain("job-7");
  });

  it("offers inbox wait with a default of 45 s, and keeps inbox check to the CLI", () => {
    const tools = new Map(mcpTools().map((t) => [t.name, t]));
    const wait = tools.get("grokbot_inbox_wait");
    expect(wait?.inputSchema.properties.timeout).toMatchObject({
      type: "string",
      default: "45s",
    });
    expect(wait?.inputSchema.properties).not.toHaveProperty("json");
    expect(tools.has("grokbot_inbox_check")).toBe(false);
  });

  it("runs inbox wait with the short default and says to call again when nothing came", async () => {
    const { runner, calls } = fakeRunner(async () => ({
      items: [],
      timedOut: true,
      waitedSeconds: 45,
      watching: { jobs: [] },
    }));
    const [response] = await exchange(
      runner,
      call(1, "grokbot_inbox_wait", {}),
    );
    expect(calls).toMatchObject([
      { name: "inbox-wait", input: { timeout: "45s" } },
    ]);
    const text = (response as { result: { content: { text: string }[] } })
      .result.content[0]?.text;
    expect(text).toContain("call grokbot_inbox_wait again");
  });

  it("adds the catch-up notice as one more text block, and nothing without one", async () => {
    const notice = {
      items: [
        {
          id: "mine0001",
          kind: "bug",
          severity: "normal",
          project: "Acme Web",
          title: "Checkout fails",
        },
      ],
    };
    const { runner } = fakeRunner(async () => ({
      agents: [],
      inboxNotice: notice,
    }));
    const [response] = await exchange(runner, call(1, "grokbot_agents", {}));
    const content = (response as { result: { content: { text: string }[] } })
      .result.content;
    expect(content).toHaveLength(2);
    expect(content[1]?.text).toContain("mine0001");
    expect(content[1]?.text).toContain("grokbot inbox-show mine0001");
    const quiet = fakeRunner(async () => ({ agents: [] }));
    const [plain] = await exchange(quiet.runner, call(2, "grokbot_agents", {}));
    expect(
      (plain as { result: { content: unknown[] } }).result.content,
    ).toHaveLength(1);
  });

  it("points a send that is not settled at inbox wait, with the job handle", () => {
    const text = summarize("send", {
      jobId: "1f2e3d4c-0000-4000-8000-000000000000",
      agent: PRIMARY_TEST,
      sentMessageId: "m-1",
      queued: false,
    });
    expect(text).toContain('call grokbot_inbox_wait with {"job":["1f2e3d4c"]}');
  });
});
