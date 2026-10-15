import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { CommandRunnerOptions } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  sendMessageRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";
import { jobStore } from "./job-store.js";

const PRIMARY = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const STAFF = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";
const ROOM = "5ca1ab1e-0000-4000-8000-000000000001";
const KIND = "GROK_BOT_AGENT_KIND_AGENT";
const ROSTER = {
  agents: [
    { id: "12928587", agentId: PRIMARY, name: "Primary Test", kind: KIND },
    { id: "12928635", agentId: STAFF, name: "Staff Test", kind: KIND },
    {
      id: "13000001",
      agentId: ROOM,
      name: "GB Test Room",
      kind: "GROK_BOT_AGENT_KIND_ROOM",
      memberAgentIds: [PRIMARY, STAFF],
    },
  ],
};

type Calls = NonNullable<Parameters<typeof fakeServer>[0]["calls"]>;

function runnerWith(calls: Calls, options: CommandRunnerOptions = {}) {
  const { server, log } = fakeServer({
    calls: { ListGrokBotAgents: [ROSTER], ...calls },
  });
  const jobs = jobStore(join(tmpdir(), "grokbot-runner-never-written"));
  return { runner: createCommandRunner({ server, jobs, ...options }), log };
}

describe("read commands", () => {
  it("agents lists every agent and room on the account", async () => {
    const { runner } = runnerWith({});
    const { agents } = await runner.run("agents", { json: false });
    expect(agents.map((a) => [a.kind, a.name, a.agentId])).toEqual([
      ["agent", "Primary Test", PRIMARY],
      ["agent", "Staff Test", STAFF],
      ["room", "GB Test Room", ROOM],
    ]);
  });

  it("team pairs each agent with its live status, idle when the server omits it", async () => {
    const { runner, log } = runnerWith({
      ListGrokBotAgentStatuses: [
        {
          statuses: [
            {
              agentId: PRIMARY,
              isRunning: true,
              live: { isRunning: true, activity: { tool: "bash" } },
            },
            {
              agentId: STAFF,
              live: { awaiting: { reason: "Approve deploy" } },
            },
          ],
        },
      ],
    });
    const { members } = await runner.run("team", { json: false });
    expect(
      members.map((m) => [
        m.agent.name,
        m.status.isRunning,
        m.status.activityTool,
        m.status.awaiting,
      ]),
    ).toEqual([
      ["Primary Test", true, "bash", null],
      ["Staff Test", false, undefined, { reason: "Approve deploy" }],
      ["GB Test Room", false, undefined, null],
    ]);
    expect(log.map((c) => [c.method, c.body])).toEqual([
      ["ListGrokBotAgents", {}],
      ["ListGrokBotAgentStatuses", { agentIds: [PRIMARY, STAFF, ROOM] }],
    ]);
  });

  it("team on an account with no agents skips the status call", async () => {
    const { runner, log } = runnerWith({ ListGrokBotAgents: [{}] });
    const { members } = await runner.run("team", { json: false });
    expect([members, log.map((c) => c.method)]).toEqual([
      [],
      ["ListGrokBotAgents"],
    ]);
  });

  it("tail reads the latest entries of the agent, ordered by seq", async () => {
    const { runner, log } = runnerWith({
      ListGrokBotTranscriptEntries: [
        {
          entries: [
            textReplyRow(9, "PONG"),
            userRow(7, "ping", { clientNonce: "m-1" }),
            sendMessageRow(8, { type: "widget" }),
          ],
        },
      ],
    });
    const { agent, entries } = await runner.run("tail", {
      agent: "primary test",
      limit: 3,
      json: false,
    });
    expect([agent.name, entries.map((e) => [e.seq, e.kind])]).toEqual([
      "Primary Test",
      [
        ["7", "user-message"],
        ["8", "card"],
        ["9", "reply"],
      ],
    ]);
    expect(log.at(-1)?.body).toEqual({
      agentId: PRIMARY,
      sessionId: "",
      limit: 3,
    });
  });

  it("interrupt asks the agent to stop and reports whether a run was active", async () => {
    const { runner, log } = runnerWith({
      InterruptGrokBotAgentRun: [{ hadActiveRun: true }, {}],
    });
    const input = { agent: "Staff Test", json: false };
    const first = await runner.run("interrupt", input);
    const second = await runner.run("interrupt", input);
    expect([first.agent.name, first.hadActiveRun, second.hadActiveRun]).toEqual(
      ["Staff Test", true, false],
    );
    expect(
      log
        .filter((c) => c.method === "InterruptGrokBotAgentRun")
        .map((c) => c.body),
    ).toEqual([
      { agentId: STAFF, reason: "user_interrupt" },
      { agentId: STAFF, reason: "user_interrupt" },
    ]);
  });
});

describe("agent selection", () => {
  it("fails before any RPC when neither --agent nor GROKBOT_AGENT names an agent", async () => {
    const { runner, log } = runnerWith({});
    const errors = await Promise.all([
      runner.run("tail", { limit: 5, json: false }).catch((e: unknown) => e),
      runner
        .run("send", { text: "ping", json: false })
        .catch((e: unknown) => e),
    ]);
    expect(
      errors.map((e) => [
        e instanceof GrokBotError && e.code,
        (e as Error).message,
      ]),
    ).toEqual([
      [
        "not-found",
        "No agent selected. Pass --agent <name|agentId> or set GROKBOT_AGENT.",
      ],
      [
        "not-found",
        "No agent selected. Pass --agent <name|agentId> or set GROKBOT_AGENT.",
      ],
    ]);
    expect(log).toEqual([]);
  });

  it("falls back to defaultAgent, lets --agent win, and accepts a room", async () => {
    const { runner, log } = runnerWith(
      { ListGrokBotTranscriptEntries: [{ entries: [] }] },
      { defaultAgent: "staff-test" },
    );
    const fromEnv = await runner.run("tail", { limit: 1, json: false });
    const fromFlag = await runner.run("tail", {
      agent: "GB Test Room",
      limit: 1,
      json: false,
    });
    expect([fromEnv.agent.name, fromFlag.agent.kind]).toEqual([
      "Staff Test",
      "room",
    ]);
    expect(
      log
        .filter((c) => c.method === "ListGrokBotTranscriptEntries")
        .map((c) => c.body.agentId),
    ).toEqual([STAFF, ROOM]);
  });
});
