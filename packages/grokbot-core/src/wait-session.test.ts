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

describe("WaitSession reuses a subagent list until its lease runs out", () => {
  const START = T + 1_000;

  function leasedList(...leases: unknown[]) {
    return {
      subagents: leases.map((freshUntilMs, i) => ({
        subagentId: `s${i}`,
        startedAtMs: T + 500,
        ...(freshUntilMs !== undefined && { freshUntilMs }),
      })),
    };
  }

  /** Records a running status at each offset and returns the reads after each one. */
  async function readsAt(
    list: unknown,
    offsetsMs: readonly number[],
  ): Promise<number[]> {
    let now = START;
    const { server, log } = fakeServer({
      calls: { ListGrokBotSubagents: [list] },
    });
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING);
    const reads = [subagentReads(log)];
    for (const offset of offsetsMs) {
      now = START + offset;
      await wait.recordStatus(RUNNING);
      reads.push(subagentReads(log));
    }
    return reads;
  }

  it("does not read before a lease that is longer than 5s", async () => {
    const list = leasedList(String(START + 30_000));
    expect(await readsAt(list, [5_000, 29_999, 30_000])).toEqual([1, 1, 1, 2]);
  });

  it("reads a lease sent as a number the same as one sent as a digit string", async () => {
    const list = leasedList(START + 30_000);
    expect(await readsAt(list, [29_999, 30_000])).toEqual([1, 1, 2]);
  });

  it("waits for the earliest lease among the subagents, ignoring ones without a lease", async () => {
    const list = leasedList(
      String(START + 40_000),
      "0",
      String(START + 20_000),
    );
    expect(await readsAt(list, [19_999, 20_000])).toEqual([1, 1, 2]);
  });

  it("never reuses a list for longer than 60s", async () => {
    const list = leasedList(String(START + 600_000));
    expect(await readsAt(list, [59_999, 60_000])).toEqual([1, 1, 2]);
  });

  it.each([
    ["in the past", String(START - 20_000)],
    ["closer than 5s", String(START + 1_000)],
  ])("reads at most every 5s when the lease is %s", async (_name, lease) => {
    const list = leasedList(lease);
    expect(await readsAt(list, [4_999, 5_000])).toEqual([1, 1, 2]);
  });

  it.each([
    ["absent", undefined],
    ["0", "0"],
    ["zero", 0],
    ["not a number", "soon"],
  ])("keeps the 5s reuse when the lease is %s", async (_name, lease) => {
    const list = leasedList(lease);
    expect(await readsAt(list, [4_999, 5_000])).toEqual([1, 1, 2]);
  });

  it("reads at once on a rising edge even while the last list is leased", async () => {
    let now = START;
    const { server, log } = fakeServer({
      calls: { ListGrokBotSubagents: [leasedList(String(START + 30_000))] },
    });
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING);
    now += 100;
    await wait.recordStatus(IDLE_STATUS);
    now += 100;
    await wait.recordStatus(RUNNING);
    expect(subagentReads(log)).toBe(2);
  });

  it("still reads a reused leased list again before a verdict other than running", async () => {
    let now = START;
    let reads = 0;
    const lease = String(START + 30_000);
    const { server } = fakeServer({
      calls: {
        ListGrokBotSubagents: () => {
          reads += 1;
          const old = {
            subagentId: "old",
            startedAtMs: T - 60_000,
            freshUntilMs: lease,
          };
          const mine = {
            subagentId: "mine",
            startedAtMs: T + 1_000,
            freshUntilMs: lease,
          };
          return { subagents: reads === 1 ? [old] : [old, mine] };
        },
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
      },
    });
    const wait = session(server, undefined, () => now);
    await wait.recordStatus(RUNNING);
    now += 2_000;
    await wait.recordStatus(RUNNING);
    await wait.readRows();
    expect(reads).toBe(2);
    expect(wait.settle()).toMatchObject({ status: "running" });
  });

  describe("without a status update", () => {
    function leasedWait(lists: readonly unknown[] | (() => unknown)) {
      const clock = { now: START };
      const { server, log } = fakeServer({
        calls: {
          ListGrokBotSubagents: lists,
          ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
        },
      });
      const wait = session(server, undefined, () => clock.now);
      return { wait, clock, log };
    }

    it("is not due before the lease and reads nothing then", async () => {
      const { wait, clock, log } = leasedWait([
        leasedList(String(START + 30_000)),
      ]);
      await wait.recordStatus(RUNNING);
      clock.now = START + 29_999;
      expect(wait.subagentsDue()).toBe(false);
      await wait.syncSubagents();
      expect(subagentReads(log)).toBe(1);
    });

    it("reads at the lease and stops holding the turn once the subagent is gone", async () => {
      const { wait, clock, log } = leasedWait([
        leasedList(String(START + 30_000)),
        {},
      ]);
      await wait.recordStatus(RUNNING);
      await wait.readRows();
      expect(wait.settle()).toMatchObject({
        status: "running",
        reason: "subagents-active",
      });
      expect(wait.subagentsDueAtMs).toBe(START + 30_000);
      clock.now = START + 30_000;
      expect(wait.subagentsDue()).toBe(true);
      await wait.syncSubagents();
      expect(subagentReads(log)).toBe(2);
      expect(wait.settle()).toMatchObject({
        status: "done",
        finalReply: "PONG",
      });
    });

    it("keeps holding the turn when the subagent is still listed, with a new lease", async () => {
      const { wait, clock } = leasedWait([
        leasedList(String(START + 30_000)),
        leasedList(String(START + 90_000)),
      ]);
      await wait.recordStatus(RUNNING);
      await wait.readRows();
      clock.now = START + 30_000;
      await wait.syncSubagents();
      expect(wait.settle()).toMatchObject({ status: "running" });
      expect(wait.subagentsDue()).toBe(false);
      expect(wait.subagentsDueAtMs).toBe(START + 90_000);
    });

    it("has no due time for a list without a lease or once the flag is off", async () => {
      const { wait } = leasedWait([leasedList(undefined)]);
      await wait.recordStatus(RUNNING);
      expect(wait.subagentsDueAtMs).toBeUndefined();
      const leased = leasedWait([leasedList(String(START + 30_000))]);
      await leased.wait.recordStatus(RUNNING);
      expect(leased.wait.subagentsDueAtMs).toBeDefined();
      await leased.wait.recordStatus(IDLE_STATUS);
      expect(leased.wait.subagentsDueAtMs).toBeUndefined();
    });

    it("leaves the list unknown and not due when the read at the lease fails", async () => {
      let fail = false;
      const { wait, clock, log } = leasedWait(() => {
        if (fail) {
          fail = false;
          throw new GrokBotError(
            "http",
            "ListGrokBotSubagents failed with HTTP 502",
          );
        }
        fail = true;
        return leasedList(String(START + 30_000));
      });
      await wait.recordStatus(RUNNING);
      await wait.readRows();
      clock.now = START + 30_000;
      await wait.syncSubagents();
      expect(subagentReads(log)).toBe(2);
      expect(wait.subagentsDue()).toBe(false);
      expect(wait.settle()).toMatchObject({
        status: "running",
        reason: "subagents-active",
      });
      await wait.recordStatus(RUNNING);
      expect(subagentReads(log)).toBe(3);
    });
  });
});
