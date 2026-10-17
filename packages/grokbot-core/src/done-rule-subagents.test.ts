import { describe, expect, it } from "vitest";
import { IDLE_STATUS } from "./agent-status.js";
import { summary } from "./fixtures/done-rule-summary.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";

const T = 1_700_000_000_000;
const SUBAGENTS = { ...IDLE_STATUS, hasRunningSubagents: true };
const echo = userRow(10, "ping", { clientNonce: "m-1", timestampMs: T });
const reply = textReplyRow(11, "PONG");

describe("Done Rule ignores subagents from other turns", () => {
  const at = (started: readonly number[] | undefined, rows = [echo, reply]) =>
    summary(rows, SUBAGENTS, "m-1", undefined, started);

  it("is done when a subagent started before our echo", () => {
    expect(at([T - 2_001])).toBe("done:PONG");
  });

  it("keeps running when a subagent started after our echo", () => {
    expect(at([T - 10_000, T + 1])).toBe("running:subagents-active");
  });

  it("counts a subagent that started within 2s before the echo", () => {
    expect(at([T - 2_000])).toBe("running:subagents-active");
  });

  it("is done when the known list is empty", () => {
    expect(at([])).toBe("done:PONG");
  });

  it("is done when a subagent started after the next unlinked owner message", () => {
    const next = userRow(20, "later", {
      clientNonce: "m-2",
      timestampMs: T + 60_000,
    });
    const rows = [echo, reply, next, textReplyRow(21, "other")];
    expect(at([T + 60_000], rows)).toBe("done:PONG");
    expect(at([T + 59_999], rows)).toBe("running:subagents-active");
  });

  it("still waits for a subagent that started after a message sharing our run", () => {
    const ours = userRow(10, "ping", {
      clientNonce: "m-1",
      requestId: "ra",
      timestampMs: T,
    });
    const linked = userRow(12, "and this", {
      clientNonce: "m-2",
      requestId: "rb",
      timestampMs: T + 5_000,
    });
    const rows = [
      ours,
      textReplyRow(11, "note", "ra"),
      linked,
      textReplyRow(13, "BOTH", "rb"),
    ];
    expect(at([T + 6_000], rows)).toBe("running:subagents-active");
  });

  it("keeps running when the subagent list is unknown", () => {
    expect(summary([echo, reply], SUBAGENTS)).toBe("running:subagents-active");
  });
});
