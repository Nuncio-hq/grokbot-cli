import { describe, expect, it } from "vitest";
import {
  IDLE_STATUS,
  type LiveStatus,
  type TurnSettlement,
} from "./agent-status.js";
import {
  reportTurn,
  type SubagentsSeen,
  type TurnReport,
} from "./done-rule.js";
import { COLOR_WIDGET } from "./fixtures/card-traces.js";
import {
  delegateReplyRow,
  delegationRow,
  sendMessageRow,
  textReplyRow,
  userRow,
  type WireEntry,
} from "./fixtures/wire-entries.js";
import { parseTranscriptEntries } from "./transcript.js";

const DEV_A = { id: "aaaaaaaa-0000-4000-8000-000000000000", name: "Dev-A" };
const T = 1_791_948_600_000;
const BUSY: LiveStatus = { ...IDLE_STATUS, isRunning: true };

const echo = userRow(10, "ping", { clientNonce: "m-1", requestId: "r1" });
const answer = textReplyRow(11, "PONG", "r1");

const settled = (
  turnId: string,
  outcome: TurnSettlement["outcome"] = "success",
  extra: Partial<TurnSettlement> = {},
): TurnSettlement => ({ turnId, outcome, settledAtMs: 1_000, ...extra });

/** `status` as the wait last saw it, plus the settlements it remembered. */
function report(
  rows: readonly WireEntry[],
  status: LiveStatus,
  settlements: readonly TurnSettlement[] = [],
  extra: {
    busyAtSend?: ReadonlyMap<string, boolean>;
    subagentStartedAtMs?: readonly number[];
    subagentsSeen?: SubagentsSeen;
  } = {},
) {
  return reportTurn({
    entries: parseTranscriptEntries(rows),
    sentMessageId: "m-1",
    status,
    settlements,
    ...extra,
  });
}

/** `running:<reason>`, `done:<reply>` or the verdict's status, as one string. */
function outcome(r: TurnReport): string {
  const { verdict } = r;
  if (verdict.status === "running") return `running:${verdict.reason}`;
  if (verdict.status === "done") return `done:${verdict.finalReply}`;
  return verdict.status;
}

describe("Done Rule with a success settlement of the turn's run", () => {
  it("is done although the bot already runs a later run", () => {
    expect(outcome(report([echo, answer], BUSY))).toBe("running:target-active");
    const withSettlement = {
      ...BUSY,
      lastTurnSettlement: settled("r1"),
    };
    const r = report([echo, answer], withSettlement);
    expect([outcome(r), r.settled, r.failure]).toEqual([
      "done:PONG",
      true,
      undefined,
    ]);
  });

  it("is done although the bot is composing or retrying a later run", () => {
    const status = { ...IDLE_STATUS, isComposing: true, isRetrying: true };
    expect(outcome(report([echo, answer], status, [settled("r1")]))).toBe(
      "done:PONG",
    );
  });

  it("uses a settlement the wait remembered after the server cleared it", () => {
    expect(outcome(report([echo, answer], BUSY, [settled("r1")]))).toBe(
      "done:PONG",
    );
  });

  it("is done past the owner's next message and the run it started", () => {
    const rows = [
      echo,
      answer,
      userRow(12, "again", { clientNonce: "m-2", requestId: "r2" }),
      textReplyRow(13, "later answer", "r2"),
    ];
    const idleAtSend = new Map([["m-2", false]]);
    const r = report(rows, BUSY, [settled("r1")], { busyAtSend: idleAtSend });
    expect(outcome(r)).toBe("done:PONG");
  });

  it("takes the newest of several settlements of the run", () => {
    const first = settled("r1", "error", { settledAtMs: 1_000 });
    const second = settled("r1", "success", { settledAtMs: 2_000 });
    const r = report([echo], IDLE_STATUS, [second, first]);
    expect([outcome(r), r.failure]).toEqual([
      "running:awaiting-final-reply",
      undefined,
    ]);
  });

  it("matches the clientNonce of our message while the turn is on our own run", () => {
    const named = settled("elsewhere", "success", { clientNonce: "m-1" });
    expect(outcome(report([echo, answer], BUSY, [named]))).toBe("done:PONG");
    const legacyEcho = userRow(10, "ping", { clientNonce: "m-1" });
    const legacyReply = textReplyRow(11, "PONG", null);
    expect(outcome(report([legacyEcho, legacyReply], BUSY, [named]))).toBe(
      "done:PONG",
    );
  });

  it("does not match the clientNonce once a delegate's reply started the next run", () => {
    const rows = [
      echo,
      delegationRow(21, "q", DEV_A, { requestId: "r1" }),
      delegateReplyRow(22, "1", DEV_A, { requestId: "r2" }),
    ];
    const named = settled("r1", "success", { clientNonce: "m-1" });
    expect(outcome(report(rows, BUSY, [named]))).toBe("running:target-active");
  });

  it("ignores a settlement of another run", () => {
    const r = report([echo, answer], BUSY, [settled("r0")]);
    expect([outcome(r), r.settled]).toEqual(["running:target-active", false]);
  });

  it("ignores an outcome it does not know", () => {
    const r = report([echo, answer], BUSY, [settled("r1", "unknown")]);
    expect([outcome(r), r.settled]).toEqual(["running:target-active", false]);
  });

  it("is unchanged without any settlement", () => {
    expect([
      outcome(report([echo, answer], IDLE_STATUS)),
      outcome(report([echo, answer], BUSY)),
      outcome(report([echo], IDLE_STATUS)),
    ]).toEqual([
      "done:PONG",
      "running:target-active",
      "running:awaiting-final-reply",
    ]);
  });
});

describe("Done Rule keeps every other condition under a success settlement", () => {
  it("keeps running while a delegation is pending", () => {
    const rows = [
      echo,
      delegationRow(21, "q", DEV_A, { requestId: "r1" }),
      textReplyRow(22, "Asked Dev-A.", "r1"),
    ];
    expect(outcome(report(rows, BUSY, [settled("r1")]))).toBe(
      "running:pending-delegation",
    );
  });

  it("follows the delegate's reply: the earlier run's settlement ends nothing", () => {
    const rows = [
      echo,
      delegationRow(21, "q", DEV_A, { requestId: "r1" }),
      textReplyRow(22, "Asked Dev-A.", "r1"),
      delegateReplyRow(23, "1", DEV_A, { requestId: "r2" }),
    ];
    expect(outcome(report(rows, BUSY, [settled("r1")]))).toBe(
      "running:target-active",
    );
    const answered = [...rows, textReplyRow(24, "RESULT: 1", "r2")];
    expect(outcome(report(answered, BUSY, [settled("r1")]))).toBe(
      "running:target-active",
    );
    expect(
      outcome(report(answered, BUSY, [settled("r1"), settled("r2")])),
    ).toBe("done:RESULT: 1");
  });

  it("awaits the owner on an open card of the turn", () => {
    const rows = [echo, sendMessageRow(11, COLOR_WIDGET, "r1")];
    expect(outcome(report(rows, BUSY))).toBe("running:target-active");
    expect(outcome(report(rows, BUSY, [settled("r1")]))).toBe(
      "awaiting-approval",
    );
  });

  it("keeps running while a subagent started in the turn", () => {
    const inTurn = { ...BUSY, hasRunningSubagents: true };
    const startedAt = [T + 10];
    expect(
      outcome(
        report([echo, answer], inTurn, [settled("r1")], {
          subagentStartedAtMs: startedAt,
        }),
      ),
    ).toBe("running:subagents-active");
  });

  it("falls back to the live status once a subagent ran in the turn, whose end starts the answering run", () => {
    const run = (startedAtMs: number[], unknownStart = false) =>
      outcome(
        report([echo, answer], BUSY, [settled("r1")], {
          subagentsSeen: { startedAtMs, unknownStart },
        }),
      );
    expect([run([T + 20]), run([], true), run([]), run([T - 10_000])]).toEqual([
      "running:target-active",
      "running:target-active",
      "done:PONG",
      "done:PONG",
    ]);
  });

  it("still needs a final reply", () => {
    const r = report([echo], BUSY, [settled("r1")]);
    expect([outcome(r), r.failure]).toEqual([
      "running:awaiting-final-reply",
      undefined,
    ]);
  });

  it("still waits while the reply streams", () => {
    const streaming = textReplyRow(11, "PO", "r1", { isStreaming: true });
    expect(outcome(report([echo, streaming], BUSY, [settled("r1")]))).toBe(
      "running:awaiting-final-reply",
    );
  });
});

describe("Done Rule on an error or cancellation settlement", () => {
  const failed = settled("r1", "error", {
    errorCode: "RATE_LIMITED",
    errorDomain: "agent",
    errorRetryable: true,
  });

  it("reports the failure while no reply answers it, whether or not the bot runs on", () => {
    for (const status of [IDLE_STATUS, BUSY]) {
      const r = report([echo], status, [failed]);
      expect([outcome(r), r.settled, r.failure]).toEqual([
        "running:awaiting-final-reply",
        true,
        failed,
      ]);
    }
  });

  it("is done with the reply when one exists", () => {
    const r = report([echo, answer], BUSY, [failed]);
    expect([outcome(r), r.failure]).toEqual(["done:PONG", undefined]);
  });

  it("does not fail a turn that still waits on a delegate or a card", () => {
    const delegated = [
      echo,
      delegationRow(21, "q", DEV_A, { requestId: "r1" }),
    ];
    const r = report(delegated, IDLE_STATUS, [failed]);
    expect([outcome(r), r.failure]).toEqual([
      "running:pending-delegation",
      undefined,
    ]);
  });

  it("is done with the reply of a cancelled run, and fails one without", () => {
    const cancelled = settled("r1", "cancelled");
    const replied = report([echo, answer], BUSY, [cancelled]);
    expect([outcome(replied), replied.failure]).toEqual([
      "done:PONG",
      undefined,
    ]);
    const silent = report([echo], IDLE_STATUS, [cancelled]);
    expect([outcome(silent), silent.failure]).toEqual([
      "running:awaiting-final-reply",
      cancelled,
    ]);
  });

  it("ignores a failure of another run", () => {
    const other = settled("r0", "error", { errorCode: "X" });
    const r = report([echo], IDLE_STATUS, [other]);
    expect([outcome(r), r.settled, r.failure]).toEqual([
      "running:awaiting-final-reply",
      false,
      undefined,
    ]);
  });

  it("reads the settlement of the status too", () => {
    const status = { ...BUSY, lastTurnSettlement: failed };
    expect(report([echo], status).failure).toEqual(failed);
  });
});
