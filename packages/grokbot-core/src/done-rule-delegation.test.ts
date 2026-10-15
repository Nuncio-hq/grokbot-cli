import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import {
  LIVE_MESSAGE_ID,
  LIVE_TRACE,
  TRACE_MESSAGE_ID,
  traceUpTo,
} from "./fixtures/delegation-trace.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  assistantRow,
  delegateReplyRow,
  delegationRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";

const RUNNING: LiveStatus = { ...IDLE_STATUS, isRunning: true };
const DEV_A = { id: "aaaaaaaa-0000-4000-8000-000000000000", name: "Dev-A" };
const DEV_B = { id: "bbbbbbbb-0000-4000-8000-000000000000", name: "Dev-B" };

describe("Done Rule on the 14 Oct live delegation (#109–#114)", () => {
  const live = (seq: number) => traceUpTo(seq, LIVE_TRACE);
  const id = LIVE_MESSAGE_ID;

  it("holds on the open delegation once the bot goes idle after SendToAgent", () => {
    expect(summary(live(111), IDLE_STATUS, id)).toBe(
      "running:pending-delegation",
    );
    expect(summary(live(112), IDLE_STATUS, id)).toBe(
      "running:pending-delegation",
    );
  });

  it("treats Staff Test's PONG at #113 as the delegate's reply, not the owner's next message", () => {
    expect(summary(live(113), IDLE_STATUS, id)).toBe(
      "running:awaiting-final-reply",
    );
  });

  it("is done at #114 with RESULT: PONG and every reply since the echo", () => {
    const v = verdict(live(114), IDLE_STATUS, id);
    expect(
      v.status === "done" && [v.finalReply, v.replies.map((r) => r.seq)],
    ).toEqual(["RESULT: PONG", ["110", "112", "114"]]);
  });
});

describe("Done Rule on the 13 Oct #143–#147 delegation trace", () => {
  const id = TRACE_MESSAGE_ID;

  it("waits for the echo before anything else", () => {
    expect(summary([], RUNNING, id)).toBe("running:awaiting-echo");
    expect(summary(traceUpTo(147), IDLE_STATUS, "someone-else")).toBe(
      "running:awaiting-echo",
    );
  });

  it("is running at the #143 progress note, the row the old CLI returned", () => {
    expect(summary(traceUpTo(143), RUNNING, id)).toBe("running:target-active");
  });

  it("holds on the open delegation at #145 even when the status flickers idle", () => {
    expect(
      summary(traceUpTo(145), { ...RUNNING, activityTool: "SendToAgent" }, id),
    ).toBe("running:target-active");
    expect(summary(traceUpTo(145), IDLE_STATUS, id)).toBe(
      "running:pending-delegation",
    );
  });

  it("waits for run B after the employee's PONG lands at #146", () => {
    expect(summary(traceUpTo(146), IDLE_STATUS, id)).toBe(
      "running:awaiting-final-reply",
    );
  });

  it("is done at #147 with RESULT: PONG and every reply since the echo", () => {
    expect(summary(traceUpTo(147), { ...RUNNING, isComposing: true }, id)).toBe(
      "running:target-active",
    );
    const v = verdict(traceUpTo(147), IDLE_STATUS, id);
    expect(
      v.status === "done" && [v.finalReply, v.replies.map((r) => r.seq)],
    ).toEqual(["RESULT: PONG", ["143", "145", "147"]]);
  });
});

describe("Done Rule on a two-delegation fan-out", () => {
  const base = [
    userRow(20, "ask A and B", { clientNonce: "m-1" }),
    delegationRow(21, "q", DEV_A),
    delegationRow(22, "q", DEV_B),
    textReplyRow(23, "Asked both."),
    delegateReplyRow(24, "A says 1", DEV_A),
    textReplyRow(25, "A answered, waiting on B."),
  ];

  it("stays pending until every delegated bot has answered", () => {
    expect(summary(base, IDLE_STATUS)).toBe("running:pending-delegation");
    const bAnswered = [...base, delegateReplyRow(26, "B says 2", DEV_B)];
    expect(summary(bAnswered, IDLE_STATUS)).toBe(
      "running:awaiting-final-reply",
    );
    expect(
      summary([...bAnswered, textReplyRow(27, "Total 3")], IDLE_STATUS),
    ).toBe("done:Total 3");
  });

  it("pairs repeat delegations to the same bot one to one", () => {
    const twice = [
      userRow(30, "go", { clientNonce: "m-1" }),
      delegationRow(31, "q1", DEV_A),
      delegateReplyRow(32, "a1", DEV_A),
      delegationRow(33, "q2", DEV_A),
      textReplyRow(34, "Asked again."),
    ];
    expect(summary(twice, IDLE_STATUS)).toBe("running:pending-delegation");
  });

  it("pairs by id when both rows carry one, so a rename still closes and a namesake does not", () => {
    const asked = [
      userRow(40, "ask A", { clientNonce: "m-1" }),
      delegationRow(41, "q", DEV_A),
    ];
    const renamed = { id: DEV_A.id, name: "Dev-A (renamed)" };
    const namesake = { id: DEV_B.id, name: DEV_A.name };
    expect(
      summary([...asked, delegateReplyRow(42, "1", renamed)], IDLE_STATUS),
    ).toBe("running:awaiting-final-reply");
    expect(
      summary([...asked, delegateReplyRow(42, "1", namesake)], IDLE_STATUS),
    ).toBe("running:pending-delegation");
  });
});

describe("Done Rule on legacy bare-name agent refs", () => {
  it("pairs a string toAgent with a string fromAgent by name", () => {
    const rows = [
      userRow(50, "ask A", { clientNonce: "m-1" }),
      assistantRow(51, "q", { toAgent: "Dev-A" }),
      textReplyRow(52, "Asked A."),
    ];
    expect(summary(rows, IDLE_STATUS)).toBe("running:pending-delegation");
    const answered = [
      ...rows,
      userRow(53, "1", { fromAgent: "Dev-A" }),
      textReplyRow(54, "A says 1"),
    ];
    expect(summary(answered, IDLE_STATUS)).toBe("done:A says 1");
  });
});
