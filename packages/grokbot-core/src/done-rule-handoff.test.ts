import { describe, expect, it } from "vitest";
import { IDLE_STATUS } from "./agent-status.js";
import { DELEGATION_GRACE_MS } from "./delegations.js";
import {
  AWAITING_STATUS,
  chainedHandoff,
  contextOf,
  DEV,
  heldAndUnanswered,
  inboundRow,
  judge,
  longHandoff,
  noteRow,
  openOf,
  outboundRow,
  ownerRow,
  PRIMARY,
  RUNNING_STATUS,
  readOf,
  STAFF,
  twoHandoffs,
  unreadOf,
} from "./fixtures/handoff-traces.js";
import { assistantRow, withEntryId } from "./fixtures/wire-entries.js";

const BASE = 1_792_405_000_000;
const at = (s: number) => BASE + Math.round(s * 1000);

describe("Done Rule follows a hand-off by its ids", () => {
  describe("the 92 s hand-off of 19 Oct (answered)", () => {
    const trace = longHandoff(BASE);
    const staff = trace.others[STAFF.id] ?? [];

    it("waits while the receiver works, and without reads of it", () => {
      const ctx = contextOf(PRIMARY, { [STAFF.id]: unreadOf(at(30)) });
      expect(judge(trace.upToNote, trace.messageId, ctx)).toBe(
        "running:pending-delegation",
      );
      expect(judge(trace.upToNote, trace.messageId)).toBe(
        "running:pending-delegation",
      );
    });

    it("waits for the answer on its way, even with the receiver idle", () => {
      const ctx = contextOf(PRIMARY, {
        [STAFF.id]: readOf(staff, at(78)),
      });
      expect(openOf(trace.upToNote, trace.messageId, ctx)).toEqual([
        "agent-outbound-a0b1c2:grace",
      ]);
      expect(judge(trace.upToNote, trace.messageId, ctx)).toBe(
        "running:pending-delegation",
      );
    });

    it("waits for the run the answer opened, then ends with the FINAL reply", () => {
      const ctx = contextOf(PRIMARY, { [STAFF.id]: readOf(staff, at(79)) });
      const answered = trace.senderRows.slice(0, 5);
      expect(openOf(answered, trace.messageId, ctx)).toEqual([]);
      expect(judge(answered, trace.messageId, ctx)).toBe(
        "running:awaiting-final-reply",
      );
      expect(judge(trace.senderRows, trace.messageId, ctx)).toBe(
        "done:FINAL: DONE-A",
      );
      expect(judge(trace.senderRows, trace.messageId)).toBe(
        "done:FINAL: DONE-A",
      );
    });
  });

  describe("a held hand-off and a handled one that was not answered", () => {
    const trace = heldAndUnanswered(BASE);
    const primary = trace.others[PRIMARY.id] ?? [];
    const done = "done:Sent one held, one woken.";

    it("pairs by agent, as before, without reads of the receiver", () => {
      expect(judge(trace.senderRows, trace.messageId)).toBe(
        "running:pending-delegation",
      );
    });

    it("waits out the grace", () => {
      const ctx = contextOf(STAFF, { [PRIMARY.id]: readOf(primary, at(5)) });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-b0c1d2:grace",
        "agent-outbound-b0c1d3:grace",
      ]);
      expect(judge(trace.senderRows, trace.messageId, ctx)).toBe(
        "running:pending-delegation",
      );
    });

    it("ends with the final reply once the grace passes", () => {
      const readAt = at(1.5) + DELEGATION_GRACE_MS + 50;
      const ctx = contextOf(STAFF, {
        [PRIMARY.id]: readOf(primary, readAt),
      });
      // The held one is released first; the woken one waits out its own grace.
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-b0c1d2:released",
        "agent-outbound-b0c1d3:grace",
      ]);
      const later = contextOf(STAFF, { [PRIMARY.id]: readOf(primary, at(30)) });
      expect(openOf(trace.senderRows, trace.messageId, later)).toEqual([
        "agent-outbound-b0c1d2:released",
        "agent-outbound-b0c1d3:released",
      ]);
      expect(judge(trace.senderRows, trace.messageId, later)).toBe(done);
    });

    it("does not call a hand-off held when the page does not reach back past it", () => {
      const ctx = contextOf(STAFF, {
        [PRIMARY.id]: readOf(primary, at(30), IDLE_STATUS, at(5)),
      });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-b0c1d2:by-agent",
        "agent-outbound-b0c1d3:released",
      ]);
    });

    it("keeps waiting while the receiver runs or awaits the owner", () => {
      for (const status of [RUNNING_STATUS, AWAITING_STATUS]) {
        const ctx = contextOf(STAFF, {
          [PRIMARY.id]: readOf(primary, at(30), status),
        });
        expect(judge(trace.senderRows, trace.messageId, ctx)).toBe(
          "running:pending-delegation",
        );
      }
      const subagents = { ...IDLE_STATUS, hasRunningSubagents: true };
      const ctx = contextOf(STAFF, {
        [PRIMARY.id]: readOf(primary, at(30), subagents),
      });
      expect(judge(trace.senderRows, trace.messageId, ctx)).toBe(
        "running:pending-delegation",
      );
    });

    it("keeps waiting when the receiver has a hand-off of its own still open", () => {
      const own = outboundRow(
        320,
        "ee0001",
        "Check this.",
        DEV,
        "rq-wake",
        at(9),
      );
      const ctx = contextOf(STAFF, {
        [PRIMARY.id]: readOf([...primary, own], at(30)),
      });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-b0c1d2:released",
        "agent-outbound-b0c1d3:working",
      ]);
    });

    it("waits out the grace for an answer the receiver wrote that has not reached the sender", () => {
      const answer = outboundRow(
        320,
        "ee0002",
        "Done.",
        STAFF,
        "rq-wake",
        at(9),
      );
      const early = contextOf(STAFF, {
        [PRIMARY.id]: readOf([...primary, answer], at(12)),
      });
      expect(openOf(trace.senderRows, trace.messageId, early)).toEqual([
        "agent-outbound-b0c1d2:released",
        "agent-outbound-b0c1d3:grace",
      ]);
      const late = contextOf(STAFF, {
        [PRIMARY.id]: readOf([...primary, answer], at(30)),
      });
      expect(openOf(trace.senderRows, trace.messageId, late)).toEqual([
        "agent-outbound-b0c1d2:released",
        "agent-outbound-b0c1d3:released",
      ]);
    });

    it("pairs by agent when the receiver's rows cannot be read", () => {
      const ctx = contextOf(STAFF, {
        [PRIMARY.id]: unreadOf(at(30), IDLE_STATUS),
      });
      expect(judge(trace.senderRows, trace.messageId, ctx)).toBe(
        "running:pending-delegation",
      );
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-b0c1d2:by-agent",
        "agent-outbound-b0c1d3:by-agent",
      ]);
    });
  });

  describe("two hand-offs to one bot", () => {
    const staffAt = (landed: Parameters<typeof twoHandoffs>[1]) => {
      const trace = twoHandoffs(BASE, landed);
      return {
        trace,
        ctx: contextOf(PRIMARY, {
          [STAFF.id]: readOf(trace.others[STAFF.id] ?? [], at(35)),
        }),
      };
    };

    it("lets neither answer close the other", () => {
      const { trace, ctx } = staffAt(["b"]);
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-aa0001:grace",
      ]);
      const reversed = staffAt(["a"]);
      expect(
        openOf(
          reversed.trace.senderRows,
          reversed.trace.messageId,
          reversed.ctx,
        ),
      ).toEqual(["agent-outbound-bb0002:grace"]);
    });

    it("closed them by agent before, when the second answer came first", () => {
      const { trace } = staffAt(["b"]);
      expect(openOf(trace.senderRows, trace.messageId)).toEqual([
        "agent-outbound-bb0002:by-agent",
      ]);
    });

    it("holds until both answers have landed, then ends with the FINAL reply", () => {
      const none = staffAt([]);
      expect(
        openOf(none.trace.senderRows, none.trace.messageId, none.ctx),
      ).toEqual(["agent-outbound-aa0001:grace", "agent-outbound-bb0002:grace"]);
      const both = staffAt(["b", "a"]);
      expect(
        openOf(both.trace.senderRows, both.trace.messageId, both.ctx),
      ).toEqual([]);
      expect(judge(both.trace.senderRows, both.trace.messageId, both.ctx)).toBe(
        "done:FINAL: A and B done",
      );
    });

    it("tells their answers apart even when the receiver is still working on one", () => {
      const trace = twoHandoffs(BASE, ["b"]);
      const ctx = contextOf(PRIMARY, {
        [STAFF.id]: readOf(
          (trace.others[STAFF.id] ?? []).slice(0, 3),
          at(35),
          RUNNING_STATUS,
        ),
      });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-aa0001:working",
      ]);
    });

    it("counts a second answer under an already answered run as closing nothing", () => {
      const trace = twoHandoffs(BASE, ["b"]);
      const extra = inboundRow(
        27,
        "bb0099",
        "Task B done.",
        STAFF,
        "rs-4",
        at(36),
      );
      const ctx = contextOf(PRIMARY, {
        [STAFF.id]: readOf(trace.others[STAFF.id] ?? [], at(37)),
      });
      expect(
        openOf([...trace.senderRows, extra], trace.messageId, ctx),
      ).toEqual(["agent-outbound-aa0001:grace"]);
    });
  });

  describe("a receiver that passes the hand-off on", () => {
    it("accepts the answer written one level deep, and nothing else closes it", () => {
      const trace = chainedHandoff(BASE, 1);
      const staff = trace.others[STAFF.id] ?? [];
      const ctx = contextOf(PRIMARY, { [STAFF.id]: readOf(staff, at(31)) });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-cc0001:grace",
      ]);
      const landed = chainedHandoff(BASE, 1, true);
      expect(openOf(landed.senderRows, landed.messageId, ctx)).toEqual([]);
    });

    it("waits while the receiver's own hand-off is open", () => {
      const trace = chainedHandoff(BASE, 1);
      const staff = (trace.others[STAFF.id] ?? []).slice(0, 2);
      const ctx = contextOf(PRIMARY, { [STAFF.id]: readOf(staff, at(60)) });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-cc0001:working",
      ]);
    });

    it("pairs by agent when the receiver hands on again from a run its own hand-off opened", () => {
      const trace = chainedHandoff(BASE, 2);
      const staff = trace.others[STAFF.id] ?? [];
      const ctx = contextOf(PRIMARY, { [STAFF.id]: readOf(staff, at(60)) });
      expect(openOf(trace.senderRows, trace.messageId, ctx)).toEqual([
        "agent-outbound-cc0001:by-agent",
      ]);
    });
  });

  describe("hand-offs the ids cannot follow", () => {
    const cloud = {
      id: "bc-00000000-0000-4000-8000-0000000000aa",
      name: "bc-00000000-0000-4000-8000-0000000000aa",
    };
    const owner = ownerRow(
      10,
      "Start a cloud agent.",
      "cloud-1",
      "rs-1",
      at(0),
    );
    const rows = [
      owner,
      withEntryId(
        assistantRow(11, "Count the files.", {
          toAgent: { ...cloud, kind: "cloud-agent" },
          requestId: "rs-1",
          timestampMs: at(2),
        }),
        "agent-outbound-ff0001",
      ),
      noteRow(12, "Started.", "rs-1", at(3)),
    ];
    const answered = [
      ...rows,
      inboundRow(13, "ff0002", "Counted 3.", cloud, "rs-2", at(60)),
      noteRow(14, "FINAL: 3 files", "rs-2", at(62)),
    ];

    it("treats a cloud agent as before, whatever else was read", () => {
      const other = contextOf(PRIMARY, {
        [STAFF.id]: readOf([], at(500)),
      });
      for (const ctx of [undefined, other]) {
        expect(openOf(rows, "cloud-1", ctx)).toEqual([
          "agent-outbound-ff0001:by-agent",
        ]);
        expect(judge(rows, "cloud-1", ctx)).toBe("running:pending-delegation");
        expect(judge(answered, "cloud-1", ctx)).toBe("done:FINAL: 3 files");
      }
    });

    it("treats a hand-off without an agent-outbound id as before", () => {
      const legacy = [
        owner,
        withEntryId(
          assistantRow(11, "Ask.", {
            toAgent: { id: STAFF.id, name: STAFF.name, kind: "agent" },
            requestId: "rs-1",
            timestampMs: at(2),
          }),
          "t77s1",
        ),
        noteRow(12, "Asked.", "rs-1", at(3)),
      ];
      const ctx = contextOf(PRIMARY, { [STAFF.id]: readOf([], at(500)) });
      expect(openOf(legacy, "cloud-1", ctx)).toEqual(["t77s1:by-agent"]);
      expect(judge(legacy, "cloud-1", ctx)).toBe("running:pending-delegation");
    });
  });
});
