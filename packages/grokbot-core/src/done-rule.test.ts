import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  blobRow,
  sendMessageRow,
  textReplyRow,
  userRow,
  wireEntry,
} from "./fixtures/wire-entries.js";

const RUNNING: LiveStatus = { ...IDLE_STATUS, isRunning: true };

describe("Done Rule on a plain one-run turn", () => {
  const echo = userRow(10, "ping", { clientNonce: "m-1" });

  it("ignores replies from earlier turns", () => {
    const earlier = [
      userRow(8, "ping", { clientNonce: "m-0" }),
      textReplyRow(9, "PONG (old)"),
    ];
    expect(summary([...earlier, echo], IDLE_STATUS)).toBe(
      "running:awaiting-final-reply",
    );
  });

  it("is done once the bot is idle with a text reply after the echo", () => {
    expect(summary([echo, textReplyRow(11, "PONG")], RUNNING)).toBe(
      "running:target-active",
    );
    expect(summary([echo, textReplyRow(11, "PONG")], IDLE_STATUS)).toBe(
      "done:PONG",
    );
  });

  it("ends the turn at the owner's next message, so an older job keeps its own reply", () => {
    const rows = [
      userRow(96, "run the script", { clientNonce: "m-old" }),
      textReplyRow(97, "Running it on your Mac now."),
      textReplyRow(98, "The script ran on your Mac."),
      userRow(99, "ping", { clientNonce: "m-new" }),
      textReplyRow(100, "PONG"),
    ];
    const old = verdict(rows, IDLE_STATUS, "m-old");
    expect(
      old.status === "done" && [old.finalReply, old.replies.map((r) => r.seq)],
    ).toEqual(["The script ran on your Mac.", ["97", "98"]]);
    expect(summary(rows, IDLE_STATUS, "m-new")).toBe("done:PONG");
  });

  it("keeps running while subagents run or the bot retries", () => {
    const rows = [echo, textReplyRow(11, "PONG")];
    expect(summary(rows, { ...IDLE_STATUS, hasRunningSubagents: true })).toBe(
      "running:subagents-active",
    );
    expect(summary(rows, { ...IDLE_STATUS, isRetrying: true })).toBe(
      "running:target-active",
    );
  });

  it("collects attachments as replies but picks the last text as final", () => {
    const file = sendMessageRow(12, {
      type: "attachment",
      url: "https://x.test/f.png",
      file_name: "f.png",
    });
    const v = verdict(
      [echo, textReplyRow(11, "Here is the file"), file],
      IDLE_STATUS,
    );
    expect(
      v.status === "done" && [v.finalReply, v.replies.map((r) => r.reply.type)],
    ).toEqual(["Here is the file", ["text", "attachment"]]);
  });
});

describe("Done Rule with an open card", () => {
  const echo = userRow(40, "clean tmp", { clientNonce: "m-1" });
  const resolved = sendMessageRow(41, {
    type: "auto-review-approval",
    approval: { status: "approved" },
  });
  const pending = sendMessageRow(42, {
    type: "local-tool-permission",
    ask: { status: "pending", target: "rm -rf /tmp/x" },
  });
  const awaiting: LiveStatus = {
    ...RUNNING,
    awaiting: { reason: "Permission needed on your computer" },
  };

  it("reports the still-pending cards while the bot awaits the owner", () => {
    const v = verdict([echo, resolved, pending], awaiting);
    expect(
      v.status === "awaiting-approval" && [
        v.reason,
        v.cards.map((c) => [c.seq, c.cardType]),
      ],
    ).toEqual([
      "Permission needed on your computer",
      [["42", "local-tool-permission"]],
    ]);
  });

  it("goes back to running then done once the card is resolved", () => {
    const allowed = sendMessageRow(
      42,
      {
        type: "local-tool-permission",
        ask: { status: "allowed", target: "rm -rf /tmp/x" },
      },
      "req-default",
      43,
    );
    const rows = [echo, resolved, pending];
    expect([
      summary(rows, RUNNING),
      summary(rows, IDLE_STATUS),
      summary([...rows, allowed, textReplyRow(44, "Cleaned.")], IDLE_STATUS),
    ]).toEqual([
      "running:target-active",
      "awaiting-approval:42",
      "done:Cleaned.",
    ]);
  });
});

describe("Done Rule with rows it does not understand", () => {
  const echo = userRow(50, "ping", { clientNonce: "m-1" });

  it("skips unknown kinds and a blob that an inline reply follows", () => {
    const rows = [
      echo,
      wireEntry(51, "event", { kind: "event", name: "tool-start" }),
      blobRow(52, "send-message", "deadbeef"),
      textReplyRow(53, "PONG"),
      sendMessageRow(54, { type: "poll", options: ["a"] }),
    ];
    expect(summary(rows, IDLE_STATUS)).toBe("done:PONG");
  });

  it("takes a send-message blob after the last text as the final reply, by marker", () => {
    const rows = [
      echo,
      textReplyRow(51, "Writing it up."),
      blobRow(52, "send-message", "deadbeef"),
    ];
    const v = verdict(rows, IDLE_STATUS);
    expect(
      v.status === "done" && [v.finalReply, v.blobHash, v.replies.length],
    ).toEqual([
      "[reply stored as blob deadbeef; run grokbot tail]",
      "deadbeef",
      1,
    ]);
  });
});
