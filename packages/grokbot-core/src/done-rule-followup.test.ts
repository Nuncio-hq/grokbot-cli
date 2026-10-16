import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary } from "./fixtures/done-rule-summary.js";
import { textReplyRow, userRow, withEntryId } from "./fixtures/wire-entries.js";

const RUN = "d98dda97";
const FOLLOW_UP = "98f70dca";
const SUBAGENTS: LiveStatus = { ...IDLE_STATUS, hasRunningSubagents: true };

/**
 * Live 16 Oct (#217 to #220): the bot posts notes, hands the research to a background
 * subagent, and its run ends. When the subagent is done the bot answers in a new run
 * (new requestId) under the same server turn number (t74).
 */
const echo = withEntryId(
  userRow(217, "Look up three Mac wallpaper app prices.", {
    clientNonce: "m-1",
    requestId: RUN,
  }),
  "t74u",
);
const note = withEntryId(
  textReplyRow(218, "Looking up today's prices now.", RUN),
  "t74s218",
);
const promise = withEntryId(
  textReplyRow(
    219,
    "I'm checking each store page and will send the prices.",
    RUN,
  ),
  "t74s219",
);
const answer = withEntryId(
  textReplyRow(220, "Prices: A $4.99, B $2.99, C free.", FOLLOW_UP),
  "t74s220",
);

describe("Done Rule on a reply posted by a follow-up run of the same turn", () => {
  it("keeps running while the subagent works", () => {
    expect(summary([echo, note, promise], SUBAGENTS)).toBe(
      "running:subagents-active",
    );
  });

  it("ends done with the follow-up run's answer, not the promise before it", () => {
    expect(summary([echo, note, promise, answer], IDLE_STATUS)).toBe(
      "done:Prices: A $4.99, B $2.99, C free.",
    );
  });

  it("never takes a run of the owner's next message as a follow-up", () => {
    const next = withEntryId(
      userRow(221, "Another question.", {
        clientNonce: "m-2",
        requestId: "c0ffee00",
      }),
      "t75u",
    );
    const other = withEntryId(
      textReplyRow(222, "Answer to another question.", "c0ffee00"),
      "t75s222",
    );
    const idleAtSend = new Map([["m-2", false]]);
    const rows = [echo, note, promise, next, other];
    expect(summary(rows, IDLE_STATUS, "m-1", idleAtSend)).toBe(
      "done:I'm checking each store page and will send the prices.",
    );
  });
});
