import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  PROBE_A_ID,
  PROBE_B_ID,
  PROBE_TRACE,
  SPIKE_IN_ORDER,
  spikeUpTo,
  TICKET_A_ID,
  TICKET_B_ID,
} from "./fixtures/shared-run-traces.js";
import {
  textReplyRow,
  userRow,
  type WireEntry,
} from "./fixtures/wire-entries.js";

const RUNNING: LiveStatus = { ...IDLE_STATUS, isRunning: true };
/** What a wait sees: only rows above the job's baseline (the highest updatedSeq before its send). */
const above = (baseline: number, rows: readonly WireEntry[]) =>
  rows.filter((row) => Number(row.updatedSeq) > baseline);
const busy = (id: string, value: boolean) => new Map([[id, value]]);
const replyTexts = (v: ReturnType<typeof verdict>) =>
  v.status === "ambiguous" ? v.replyText.split("\n\n") : v;

describe("one run answering two messages (15 Oct spike, #169 to #179)", () => {
  it("does not end ticket A on its progress note while the run that took it over works on it", () => {
    expect(summary(spikeUpTo(176), IDLE_STATUS, TICKET_A_ID)).toBe(
      "running:pending-delegation",
    );
  });

  it("waits for the cloud agent's result before ticket A settles", () => {
    expect(summary(spikeUpTo(177), IDLE_STATUS, TICKET_A_ID)).toBe(
      "running:awaiting-final-reply",
    );
  });

  it("ends ticket A as ambiguous with every reply of the shared run, never as done", () => {
    const v = verdict(SPIKE_IN_ORDER, IDLE_STATUS, TICKET_A_ID);
    expect(v.status === "ambiguous" && v.reason).toBe(
      "the bot may have answered this message in one run together with message #171",
    );
    expect(replyTexts(v)).toEqual([
      "Starting the cloud agent for ticket A now.",
      "Running ticket B now; ticket A is next.",
      "RESULT B: 1.2.3",
      "Ticket A's cloud agent is running.",
      "RESULT A: 42",
    ]);
  });

  it("never ends ticket B done with ticket A's result when B was sent mid-run", () => {
    const v = verdict(
      above(170, SPIKE_IN_ORDER),
      IDLE_STATUS,
      TICKET_B_ID,
      busy(TICKET_B_ID, true),
    );
    expect(v.status === "ambiguous" && v.reason).toBe(
      "the bot may have answered this message in one run together with the message it was busy with when this one arrived",
    );
    expect(replyTexts(v)).toEqual([
      "Running ticket B now; ticket A is next.",
      "RESULT B: 1.2.3",
      "Ticket A's cloud agent is running.",
      "RESULT A: 42",
    ]);
  });

  it("ties ticket B to ticket A from the rows alone when the earlier message is in view", () => {
    const v = verdict(SPIKE_IN_ORDER, IDLE_STATUS, TICKET_B_ID);
    expect(v.status === "ambiguous" && v.reason).toBe(
      "the bot may have answered this message in one run together with message #169",
    );
  });

  it("keeps ticket B running while the shared run is still out", () => {
    expect(
      summary(
        above(170, spikeUpTo(176)),
        IDLE_STATUS,
        TICKET_B_ID,
        busy(TICKET_B_ID, true),
      ),
    ).toBe("running:pending-delegation");
  });
});

describe("a message that reaches the bot before it answered the previous one (16 Oct probe, #180 to #182)", () => {
  it("ends A ambiguous with the shared reply instead of waiting forever", () => {
    const v = verdict(above(179, PROBE_TRACE), IDLE_STATUS, PROBE_A_ID);
    expect(v.status === "ambiguous" && [v.reason, v.replyText]).toEqual([
      "the bot may have answered this message in one run together with message #181",
      "BETA",
    ]);
  });

  it("ties A to B even if B's job saw the bot idle, since A was never answered", () => {
    expect(
      summary(
        above(179, PROBE_TRACE),
        IDLE_STATUS,
        PROBE_A_ID,
        busy(PROBE_B_ID, false),
      ),
    ).toBe("ambiguous:BETA");
  });

  it("marks B ambiguous when B was sent mid-run", () => {
    expect(
      summary(
        above(180, PROBE_TRACE),
        IDLE_STATUS,
        PROBE_B_ID,
        busy(PROBE_B_ID, true),
      ),
    ).toBe("ambiguous:BETA");
  });

  it("stays running while the bot works", () => {
    expect(summary(above(179, PROBE_TRACE), RUNNING, PROBE_A_ID)).toBe(
      "running:target-active",
    );
  });
});

describe("attribution stays exact when the evidence allows it", () => {
  const rows = [
    userRow(10, "ping", { clientNonce: "m-1", requestId: "r1" }),
    textReplyRow(11, "PONG", "r1"),
    userRow(12, "second", { clientNonce: "m-2", requestId: "r2" }),
    textReplyRow(13, "second answer", "r2"),
  ];

  it("keeps sequential messages apart when the later one's job found the bot idle", () => {
    const idle = busy("m-2", false);
    expect([
      summary(rows, IDLE_STATUS, "m-1", idle),
      summary(rows, IDLE_STATUS, "m-2", idle),
    ]).toEqual(["done:PONG", "done:second answer"]);
  });

  it("does not trust a later message with no record of how it reached the bot", () => {
    expect(summary(rows, IDLE_STATUS, "m-1")).toBe(
      "ambiguous:PONG\n\nsecond answer",
    );
  });

  it("keeps a message sent while idle apart from an earlier message out of view", () => {
    expect(summary(rows.slice(2), IDLE_STATUS, "m-2", busy("m-2", false))).toBe(
      "done:second answer",
    );
  });
});
