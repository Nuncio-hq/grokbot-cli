import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  delegateReplyRow,
  delegationRow,
  sendMessageRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";

const DEV_A = { id: "aaaaaaaa-0000-4000-8000-000000000000", name: "Dev-A" };
const DEV_B = { id: "bbbbbbbb-0000-4000-8000-000000000000", name: "Dev-B" };
const echo = (seq: number, requestId: string, clientNonce = "m-1") =>
  userRow(seq, "ping", { clientNonce, requestId });

describe("Done Rule keys the turn by requestId", () => {
  it("ignores an earlier task's answer posted after our echo", () => {
    const rows = [echo(10, "r1"), textReplyRow(11, "old task answer", "r0")];
    expect(summary(rows, IDLE_STATUS)).toBe("running:awaiting-final-reply");
    expect(
      summary([...rows, textReplyRow(12, "PONG", "r1")], IDLE_STATUS),
    ).toBe("done:PONG");
  });

  it("gives each of two back-to-back sends its own run once the later one found the bot idle", () => {
    const rows = [
      echo(10, "ra", "m-a"),
      textReplyRow(11, "note A", "ra"),
      echo(12, "rb", "m-b"),
      textReplyRow(13, "final A", "ra"),
    ];
    const idle = new Map([["m-b", false]]);
    expect(summary(rows, IDLE_STATUS, "m-a", idle)).toBe("done:final A");
    expect(summary(rows, IDLE_STATUS, "m-b", idle)).toBe(
      "running:awaiting-final-reply",
    );
    expect(summary(rows, IDLE_STATUS, "m-a")).toBe(
      "ambiguous:note A\n\nfinal A",
    );
  });

  it("follows the delegate's reply past an owner message sent to the idle bot meanwhile", () => {
    const rows = [
      echo(20, "r1"),
      delegationRow(21, "q", DEV_A, { requestId: "r1" }),
      textReplyRow(22, "Asked Dev-A.", "r1"),
      echo(23, "r3", "m-2"),
      textReplyRow(24, "hello", "r3"),
      delegateReplyRow(25, "A says 1", DEV_A, { requestId: "r2" }),
    ];
    const idle = new Map([["m-2", false]]);
    expect(summary(rows, IDLE_STATUS, "m-1", idle)).toBe(
      "running:awaiting-final-reply",
    );
    const all = [...rows, textReplyRow(26, "Total 1", "r2")];
    const v = verdict(all, IDLE_STATUS, "m-1", idle);
    expect(
      v.status === "done" && [v.finalReply, v.replies.map((r) => r.seq)],
    ).toEqual(["Total 1", ["22", "26"]]);
    expect(summary(all, IDLE_STATUS)).toBe(
      "ambiguous:Asked Dev-A.\n\nhello\n\nTotal 1",
    );
  });

  it("ignores another bot's unsolicited message and the reply to it", () => {
    const rows = [
      echo(30, "r1"),
      textReplyRow(31, "PONG", "r1"),
      delegateReplyRow(32, "hi there", DEV_B, { requestId: "r5" }),
      textReplyRow(33, "hi Dev-B", "r5"),
    ];
    expect(summary(rows, IDLE_STATUS)).toBe("done:PONG");
  });

  it("takes the final reply from the latest run, not a late note of the first", () => {
    const rows = [
      echo(40, "r1"),
      delegationRow(41, "q", DEV_A, { requestId: "r1" }),
      delegateReplyRow(42, "1", DEV_A, { requestId: "r2" }),
      textReplyRow(43, "RESULT: 1", "r2"),
      textReplyRow(44, "Still waiting on Dev-A.", "r1"),
    ];
    expect(summary(rows, IDLE_STATUS)).toBe("done:RESULT: 1");
  });
});

describe("Done Rule on rows without a requestId", () => {
  it("counts them only up to the owner's next message", () => {
    const rows = [
      echo(50, "r1"),
      textReplyRow(51, "legacy reply", null),
      userRow(52, "next question", { clientNonce: "m-2" }),
      textReplyRow(53, "answer to the next question", null),
    ];
    const v = verdict(rows, IDLE_STATUS);
    expect(
      v.status === "done" && [v.finalReply, v.replies.map((r) => r.seq)],
    ).toEqual(["legacy reply", ["51"]]);
  });

  it("falls back to position when the echo itself has no requestId", () => {
    const rows = [
      userRow(60, "ping", { clientNonce: "m-1" }),
      textReplyRow(61, "PONG", "r9"),
      userRow(62, "next", { clientNonce: "m-2" }),
      textReplyRow(63, "next answer", "r9"),
    ];
    expect(summary(rows, IDLE_STATUS)).toBe("done:PONG");
  });
});

describe("Done Rule on row versions and streaming rows", () => {
  it("keeps the newest version of a row whatever the input order", () => {
    const rows = [
      echo(70, "r1"),
      textReplyRow(71, "PONG (edited)", "r1", { updatedSeq: 75 }),
      textReplyRow(71, "PONG (draft)", "r1"),
    ];
    expect(summary(rows, IDLE_STATUS)).toBe("done:PONG (edited)");
  });

  it("waits while the newest reply is still streaming, then takes it", () => {
    const note = textReplyRow(81, "Working on it.", "r1");
    const partial = textReplyRow(82, "PO", "r1", { isStreaming: true });
    const rows = [echo(80, "r1"), note, partial];
    expect(summary(rows, IDLE_STATUS)).toBe("running:awaiting-final-reply");
    const finished = textReplyRow(82, "PONG", "r1", { updatedSeq: 83 });
    expect(summary([...rows, finished], IDLE_STATUS)).toBe("done:PONG");
  });
});

describe("Done Rule awaiting the owner", () => {
  const awaiting: LiveStatus = {
    ...IDLE_STATUS,
    isRunning: true,
    awaiting: { reason: "Pick one" },
  };
  const card = (seq: number, requestId: string) =>
    sendMessageRow(
      seq,
      { type: "widget", ask: { status: "pending" } },
      requestId,
    );

  it("reports only cards of this turn", () => {
    const rows = [echo(90, "r1"), card(91, "r1"), card(92, "r7")];
    const v = verdict(rows, awaiting);
    expect(
      v.status === "awaiting-approval" && v.cards.map((c) => c.seq),
    ).toEqual(["91"]);
  });

  it("keeps running when the awaited card belongs to another turn", () => {
    const rows = [
      echo(90, "r1"),
      textReplyRow(91, "PONG", "r1"),
      card(92, "r7"),
    ];
    expect(summary(rows, awaiting)).toBe("running:target-active");
  });
});
