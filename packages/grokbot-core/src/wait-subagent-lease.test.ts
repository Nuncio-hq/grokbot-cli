import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerTransport } from "./contracts.js";
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";
import { type WaitResult, waitForDone } from "./wait-for-done.js";

const AGENT = "agent-1";
const T = 1_700_000_000_000;
const START = T + 1_000;
const job = {
  agentId: AGENT,
  sentMessageId: "m-1",
  baselineUpdatedSeq: "9",
};
const echo = userRow(10, "ping", { clientNonce: "m-1", timestampMs: T });
const reply = textReplyRow(11, "PONG");

/** One subagent of this turn, leased until `leaseMs` after START (none when undefined). */
function listed(leaseMs?: number) {
  return {
    subagents: [
      {
        subagentId: "s",
        startedAtMs: T + 500,
        ...(leaseMs !== undefined && { freshUntilMs: String(START + leaseMs) }),
      },
    ],
  };
}

/**
 * The bot has answered and the status stays at `hasRunningSubagents`; no frame ever
 * arrives on the stream, so only the wait's own timer can re-read the list.
 */
function leasedBot(subagents: readonly unknown[] | (() => unknown)) {
  return fakeServer({
    calls: {
      ListGrokBotAgentStatuses: [
        {
          statuses: [{ agentId: AGENT, live: { hasRunningSubagents: true } }],
        },
      ],
      ListGrokBotSubagents: subagents,
      ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
    },
  });
}

function reads(log: readonly { method: string }[]): number {
  return log.filter((c) => c.method === "ListGrokBotSubagents").length;
}

function startWait(server: ServerTransport) {
  const stop = new AbortController();
  const result: Promise<WaitResult | undefined> = waitForDone({
    server,
    job,
    timeoutMs: 600_000,
    quietWindowMs: 0,
    reconnectDelayMs: 1,
    signal: stop.signal,
  }).catch(() => undefined);
  return { result, stop };
}

describe("waitForDone re-reads a leased subagent list at its lease", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes at the lease when the subagent is gone, without a status update", async () => {
    const { server, log } = leasedBot([listed(30_000), {}]);
    const { result } = startWait(server);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reads(log)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: "done", finalReply: "PONG" });
    expect(reads(log)).toBe(2);
  });

  it("keeps waiting while the subagent stays listed, reading again at each new lease", async () => {
    const { server, log } = leasedBot([
      listed(30_000),
      listed(90_000),
      listed(150_000),
    ]);
    const { result, stop } = startWait(server);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(reads(log)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads(log)).toBe(3);
    stop.abort();
    expect(await result).toBeUndefined();
  });

  it("polls a list whose lease already passed every 5s, not in a loop", async () => {
    const { server, log } = leasedBot([listed(-20_000)]);
    const { result, stop } = startWait(server);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reads(log)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads(log)).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads(log)).toBe(5);
    stop.abort();
    expect(await result).toBeUndefined();
  });

  it("reads nothing more when the list has no lease", async () => {
    const { server, log } = leasedBot([listed()]);
    const { result, stop } = startWait(server);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads(log)).toBe(1);
    stop.abort();
    expect(await result).toBeUndefined();
  });

  it("keeps waiting, with the list unknown, when the read at the lease fails", async () => {
    let calls = 0;
    const { server, log } = leasedBot(() => {
      calls += 1;
      if (calls === 1) return listed(30_000);
      throw new GrokBotError(
        "http",
        "ListGrokBotSubagents failed with HTTP 502",
      );
    });
    const { result, stop } = startWait(server);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads(log)).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads(log)).toBe(2);
    stop.abort();
    expect(await result).toBeUndefined();
  });
});
