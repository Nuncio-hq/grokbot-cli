import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import { GrokBotError } from "./contracts.js";
import { STAFF_TEST } from "./fixtures/delegation-trace.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  delegateReplyRow,
  delegationRow,
  sendMessageRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";
import { type JobRecord, jobStore } from "./job-store.js";

const AGENT = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const ROSTER = {
  agents: [
    {
      id: "12928587",
      agentId: AGENT,
      name: "Primary Test",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
    },
  ],
};
const ACCEPTED = { dispatched: true, delivery: "ACCEPTED_TEMPORAL" };
const NOW = 1_791_948_600_000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The bot's own status fields, without the scripted status of the bot it messaged. */
function withoutDelegate(status: object): object {
  const { delegate: _, ...own } = status as { delegate?: unknown };
  return own;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-runner-send-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("send", () => {
  it("reads the baseline before sending and saves a pending job", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotAgents: [ROSTER],
        ListGrokBotTranscriptEntries: [
          {
            generation: "2",
            entries: [
              textReplyRow(139, "older"),
              sendMessageRow(140, { type: "widget" }, "r-1", 141, {
                respondedValue: "Blue",
              }),
            ],
          },
        ],
        ListGrokBotAgentStatuses: [{ statuses: [{ agentId: AGENT }] }],
        SendGrokBotUserMessage: [ACCEPTED],
      },
    });
    const runner = createCommandRunner({ server, jobs: jobStore(dir) });
    const out = await runner.run("send", {
      text: "ping",
      agent: "primary-test",
      json: false,
    });

    const record: JobRecord = {
      jobId: out.jobId,
      agentId: AGENT,
      agentName: "Primary Test",
      queuedAtMs: NOW,
      sentMessageId: out.sentMessageId,
      sentAtMs: NOW,
      baselineUpdatedSeq: "141",
      generation: "2",
      botBusyAtSend: false,
      state: { status: "pending" },
    };
    expect([
      UUID_V4.test(out.jobId),
      UUID_V4.test(out.sentMessageId),
      out.jobId === out.sentMessageId,
      out.agent.name,
      out.queued,
    ]).toEqual([true, true, false, "Primary Test", false]);
    expect(log.map((c) => [c.method, c.body])).toEqual([
      ["ListGrokBotAgents", {}],
      [
        "ListGrokBotTranscriptEntries",
        { agentId: AGENT, sessionId: "", limit: 20 },
      ],
      ["ListGrokBotAgentStatuses", { agentIds: [AGENT] }],
      [
        "SendGrokBotUserMessage",
        {
          agentId: AGENT,
          messageId: out.sentMessageId,
          text: "ping",
          sentAtMs: "1791948600000",
          sessionId: "",
        },
      ],
    ]);
    expect(await jobStore(dir).list()).toEqual([record]);
  });

  it.each([
    [
      "running",
      { isRunning: true },
      [textReplyRow(139, "Working on it.")],
      true,
    ],
    ["awaiting the owner", { live: { awaiting: "Pick one" } }, [], true],
    [
      "idle with an unanswered message as its newest row",
      {},
      [userRow(140, "earlier ask", { clientNonce: "m-0" })],
      true,
    ],
    [
      "idle with an open card as its newest row",
      {},
      [sendMessageRow(140, { type: "widget" }, "r-1")],
      true,
    ],
    [
      "idle while its subagents still run",
      { live: { hasRunningSubagents: true } },
      [textReplyRow(139, "Started a cloud agent.")],
      true,
    ],
    [
      "idle while a delegate's reply is still due",
      {},
      [
        delegationRow(137, "Reply PONG.", STAFF_TEST),
        textReplyRow(138, "Asked Staff Test."),
      ],
      true,
    ],
    [
      "idle while the bot it messaged long ago is still working",
      { delegate: { isRunning: true } },
      [
        delegationRow(137, "Reply PONG.", STAFF_TEST),
        textReplyRow(138, "Asked Staff Test."),
      ],
      true,
    ],
    [
      "idle when the bot it messaged long ago is idle and never replied",
      { delegate: {} },
      [
        delegationRow(137, "Reply PONG.", STAFF_TEST),
        textReplyRow(138, "Asked Staff Test."),
      ],
      false,
    ],
    [
      "idle after its last reply",
      {},
      [
        delegationRow(136, "Reply PONG.", STAFF_TEST),
        delegateReplyRow(137, "PONG", STAFF_TEST),
        textReplyRow(139, "RESULT: PONG"),
      ],
      false,
    ],
  ])(
    "queues the message while the bot is busy, else sends it as idle (%s)",
    async (_, status, entries, busy) => {
      const { server, log } = fakeServer({
        calls: {
          ListGrokBotAgents: [ROSTER],
          ListGrokBotTranscriptEntries: [{ entries }],
          ListGrokBotAgentStatuses: [
            {
              statuses: [
                { agentId: AGENT, ...withoutDelegate(status) },
                ...("delegate" in status
                  ? [{ agentId: STAFF_TEST.id, ...status.delegate }]
                  : []),
              ],
            },
          ],
          SendGrokBotUserMessage: [ACCEPTED],
        },
      });
      const runner = createCommandRunner({ server, jobs: jobStore(dir) });
      const out = await runner.run("send", {
        text: "second ask",
        agent: AGENT,
        json: false,
      });
      const saved = await jobStore(dir).load(out.jobId);
      const sends = log.filter((c) => c.method === "SendGrokBotUserMessage");
      expect([
        out.queued,
        saved?.state.status,
        saved?.text,
        saved?.botBusyAtSend,
        sends.length,
      ]).toEqual(
        busy
          ? [true, "queued", "second ask", undefined, 0]
          : [false, "pending", undefined, false, 1],
      );
    },
  );

  it("takes generation 0 and baseline 0 from an empty transcript", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotAgents: [ROSTER],
        ListGrokBotTranscriptEntries: [{}],
        ListGrokBotAgentStatuses: [{ statuses: [] }],
        SendGrokBotUserMessage: [ACCEPTED],
      },
    });
    const runner = createCommandRunner({ server, jobs: jobStore(dir) });
    const out = await runner.run("send", {
      text: "hi",
      agent: AGENT,
      json: false,
    });
    const saved = await jobStore(dir).load(out.jobId);
    expect([saved?.baselineUpdatedSeq, saved?.generation]).toEqual(["0", "0"]);
  });

  it.each([
    [
      {
        delivery: "GROK_BOT_DELIVERY_REFUSED",
        refusal: { failureCode: "BOT_PAUSED", message: "The bot is paused." },
      },
      "SendGrokBotUserMessage refused the message: The bot is paused. (BOT_PAUSED)",
    ],
    [
      { dispatched: true, delivery: "REFUSED" },
      "SendGrokBotUserMessage refused the message: delivery REFUSED",
    ],
    [
      {},
      "SendGrokBotUserMessage did not dispatch the message (delivery unset)",
    ],
  ])(
    "fails with a protocol error and saves no job for %j",
    async (response, message) => {
      const { server } = fakeServer({
        calls: {
          ListGrokBotAgents: [ROSTER],
          ListGrokBotTranscriptEntries: [{ entries: [] }],
          ListGrokBotAgentStatuses: [{ statuses: [] }],
          SendGrokBotUserMessage: [response],
        },
      });
      const runner = createCommandRunner({ server, jobs: jobStore(dir) });
      const error = await runner
        .run("send", { text: "ping", agent: AGENT, json: false })
        .catch((e: unknown) => e);
      expect([
        error instanceof GrokBotError && error.code,
        (error as Error).message,
      ]).toEqual(["protocol", message]);
      expect(await jobStore(dir).list()).toEqual([]);
    },
  );
});
