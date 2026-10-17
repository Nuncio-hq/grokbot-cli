import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import type { ServerTransport } from "./contracts.js";
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";
import { waitForDone } from "./wait-for-done.js";
import { WaitSession } from "./wait-session.js";

const AGENT = "agent-1";
const T = 1_700_000_000_000;
const job = {
  agentId: AGENT,
  sentMessageId: "m-1",
  baselineUpdatedSeq: "9",
};
const echo = userRow(10, "ping", { clientNonce: "m-1", timestampMs: T });
const reply = textReplyRow(11, "PONG");

const RUNNING: LiveStatus = { ...IDLE_STATUS, hasRunningSubagents: true };

function session(
  server: ServerTransport,
  signal = new AbortController().signal,
  now?: () => number,
) {
  return new WaitSession({
    server,
    job,
    signal,
    backlogLimit: 50,
    report: () => {},
    onNewRows: () => {},
    ...(now && { now }),
  });
}

function subagentReads(log: readonly { method: string }[]): number {
  return log.filter((c) => c.method === "ListGrokBotSubagents").length;
}

describe("WaitSession lists subagents only while they run", () => {
  it("calls ListGrokBotSubagents from a status read only while the flag is true", async () => {
    let live: Record<string, unknown> = {};
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotAgentStatuses: () => ({
          statuses: [{ agentId: AGENT, live }],
        }),
        ListGrokBotSubagents: [
          {
            subagents: [{ subagentId: "s", startedAtMs: String(T - 10_000) }],
          },
        ],
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
      },
    });
    const wait = session(server);
    await wait.refreshStatus();
    live = { hasRunningSubagents: true };
    await wait.refreshStatus();
    await wait.readRows();
    expect(wait.settle()).toMatchObject({ status: "done", finalReply: "PONG" });
    live = {};
    await wait.refreshStatus();
    expect(log.filter((c) => c.method === "ListGrokBotSubagents")).toEqual([
      {
        kind: "call",
        method: "ListGrokBotSubagents",
        body: { agentId: AGENT },
      },
    ]);
  });

  it("calls ListGrokBotSubagents after a stream status only while the flag is true", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotAgentStatuses: [
          { statuses: [{ agentId: AGENT, live: { isRunning: true } }] },
        ],
        ListGrokBotSubagents: [
          {
            subagents: [
              {
                subagentId: "s",
                subagentType: "cloud",
                title: "work",
                startedAtMs: T + 5,
              },
            ],
          },
        ],
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
      },
      streams: [
        [
          {
            agentState: {
              live: [{ agentId: AGENT, hasRunningSubagents: true }],
            },
          },
          { agentState: { live: [{ agentId: AGENT }] } },
        ],
      ],
    });
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 2_000,
      quietWindowMs: 0,
      reconnectDelayMs: 1,
    });
    expect(result.status === "done" && result.finalReply).toBe("PONG");
    expect(log.map((c) => c.method)).toEqual([
      "ListGrokBotAgentStatuses",
      "ListGrokBotTranscriptEntries",
      "WatchGrokBotTranscripts",
      "ListGrokBotSubagents",
      "ListGrokBotTranscriptEntries",
    ]);
  });

  it("keeps running when ListGrokBotSubagents fails", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotAgentStatuses: [
          {
            statuses: [{ agentId: AGENT, live: { hasRunningSubagents: true } }],
          },
        ],
        ListGrokBotSubagents: () => {
          throw new GrokBotError(
            "http",
            "ListGrokBotSubagents failed with HTTP 502",
          );
        },
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
      },
    });
    const wait = session(server);
    await wait.refreshStatus();
    await wait.readRows();
    expect(wait.settle()).toMatchObject({
      status: "running",
      reason: "subagents-active",
    });
  });
});

describe("WaitSession throttles ListGrokBotSubagents", () => {
  const listed = {
    subagents: [{ subagentId: "s", startedAtMs: T }],
  };

  function listedServer() {
    return fakeServer({ calls: { ListGrokBotSubagents: [listed] } });
  }

  it("reads once for several statuses within 5s", async () => {
    let now = 10_000;
    const { server, log } = listedServer();
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING);
    now += 1_000;
    await wait.recordStatus(RUNNING);
    now += 3_999;
    await wait.recordStatus(RUNNING);
    expect(subagentReads(log)).toBe(1);
  });

  it("reads again once the last list is 5s old", async () => {
    let now = 10_000;
    const { server, log } = listedServer();
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING);
    now += 5_000;
    await wait.recordStatus(RUNNING);
    expect(subagentReads(log)).toBe(2);
  });

  it("reads at once when the flag turns off and on again", async () => {
    let now = 10_000;
    const { server, log } = listedServer();
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING);
    now += 100;
    await wait.recordStatus(IDLE_STATUS);
    now += 100;
    await wait.recordStatus(RUNNING);
    expect(subagentReads(log)).toBe(2);
  });

  it("retries a failed read on the next status and stays running while the list is unknown", async () => {
    let fail = true;
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotSubagents: () => {
          if (fail) {
            fail = false;
            throw new GrokBotError(
              "http",
              "ListGrokBotSubagents failed with HTTP 502",
            );
          }
          return {
            subagents: [{ subagentId: "s", startedAtMs: String(T - 10_000) }],
          };
        },
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
      },
    });
    const wait = session(server, undefined, () => 10_000);
    await wait.recordStatus(RUNNING);
    await wait.readRows();
    expect(wait.settle()).toMatchObject({
      status: "running",
      reason: "subagents-active",
    });
    await wait.recordStatus(RUNNING);
    expect(subagentReads(log)).toBe(2);
    expect(wait.settle()).toMatchObject({ status: "done", finalReply: "PONG" });
  });
});

describe("review probe: a subagent started for this turn inside the 5s window", () => {
  it("stays running when a new subagent appears after the reply", async () => {
    let now = 10_000;
    let reads = 0;
    const { server } = fakeServer({
      calls: {
        ListGrokBotSubagents: () => {
          reads += 1;
          const old = { subagentId: "old", startedAtMs: String(T - 60_000) };
          const mine = { subagentId: "mine", startedAtMs: String(T + 1_000) };
          return { subagents: reads === 1 ? [old] : [old, mine] };
        },
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
      },
    });
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING); // flag already on from another turn
    now += 2_000; // this turn starts a subagent; flag stays on, no rising edge
    await wait.recordStatus(RUNNING);
    await wait.readRows();
    expect(wait.settle()).toMatchObject({ status: "running" });
  });
});
