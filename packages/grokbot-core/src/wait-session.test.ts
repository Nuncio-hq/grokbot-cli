import { describe, expect, it } from "vitest";
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

function session(
  server: ServerTransport,
  signal = new AbortController().signal,
) {
  return new WaitSession({
    server,
    job,
    signal,
    backlogLimit: 50,
    report: () => {},
    onNewRows: () => {},
  });
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
