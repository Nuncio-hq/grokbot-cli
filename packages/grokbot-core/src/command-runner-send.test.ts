import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { sendMessageRow, textReplyRow } from "./fixtures/wire-entries.js";
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
              sendMessageRow(140, { type: "widget" }, "r-1", 141),
            ],
          },
        ],
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
      sentMessageId: out.sentMessageId,
      sentAtMs: NOW,
      baselineUpdatedSeq: "141",
      generation: "2",
      state: { status: "pending" },
    };
    expect([
      UUID_V4.test(out.jobId),
      UUID_V4.test(out.sentMessageId),
      out.jobId === out.sentMessageId,
      out.agent.name,
    ]).toEqual([true, true, false, "Primary Test"]);
    expect(log.map((c) => [c.method, c.body])).toEqual([
      ["ListGrokBotAgents", {}],
      [
        "ListGrokBotTranscriptEntries",
        { agentId: AGENT, sessionId: "", limit: 5 },
      ],
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

  it("takes generation 0 and baseline 0 from an empty transcript", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotAgents: [ROSTER],
        ListGrokBotTranscriptEntries: [{}],
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
