import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import { createRunnerContext } from "./command-runner-context.js";
import {
  type CallOptions,
  type GatewayTransport,
  GrokBotError,
  type JsonObject,
} from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { jobStore } from "./job-store.js";

const ROSTER = {
  agents: [
    {
      id: "1",
      agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09",
      name: "Primary Test",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
    },
  ],
};
const jobs = jobStore(join(tmpdir(), "grokbot-context-never-written"));

describe("runner gateway", () => {
  it("never runs EnsureSandBox for Phase 01 commands", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotAgents: [ROSTER],
        ListGrokBotAgentStatuses: [{ statuses: [] }],
        ListGrokBotTranscriptEntries: [{ entries: [] }],
        InterruptGrokBotAgentRun: [{}],
      },
    });
    const runner = createCommandRunner({
      server,
      jobs,
      defaultAgent: "Primary Test",
    });
    await runner.run("agents", { json: false });
    await runner.run("team", { json: false });
    await runner.run("tail", { limit: 1, json: false });
    await runner.run("interrupt", { json: false });
    expect(log.map((c) => c.method)).toStrictEqual([
      "ListGrokBotAgents",
      "ListGrokBotAgents",
      "ListGrokBotAgentStatuses",
      "ListGrokBotAgents",
      "ListGrokBotTranscriptEntries",
      "ListGrokBotAgents",
      "InterruptGrokBotAgentRun",
    ]);
  });

  it("runs EnsureSandBox on the runner's server at the first gateway call", async () => {
    const { server, log } = fakeServer({
      calls: { EnsureSandBox: [{ gatewayUrl: "https://box.example" }] },
    });
    const ctx = createRunnerContext({ server, jobs });
    await expect(ctx.gateway.call("listAgents", {})).rejects.toEqual(
      new GrokBotError(
        "protocol",
        "EnsureSandBox did not return gatewayUrl, gatewayToken, and networkToken.",
      ),
    );
    expect(log.map((c) => c.method)).toStrictEqual(["EnsureSandBox"]);
  });

  it("uses an injected gateway instead of building one", async () => {
    const seen: [string, JsonObject, CallOptions | undefined][] = [];
    const gateway: GatewayTransport = {
      async call(method, body, options) {
        seen.push([method, body, options]);
        return { agents: [] };
      },
    };
    const { server, log } = fakeServer({});
    const ctx = createRunnerContext({ server, jobs, gateway });
    const reply = await ctx.gateway.call(
      "callMcpAppTool",
      { tool: "t" },
      { confirmed: true },
    );
    expect([reply, seen, log]).toStrictEqual([
      { agents: [] },
      [["callMcpAppTool", { tool: "t" }, { confirmed: true }]],
      [],
    ]);
  });
});
