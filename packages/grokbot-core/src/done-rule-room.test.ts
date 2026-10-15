import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import { sendMessageRow, userRow } from "./fixtures/wire-entries.js";
import { parseTranscriptEntries } from "./transcript.js";

const PROBE = { id: "8a17b73b-afd3-4986-aea0-60d5399b779c", name: "Probe" };
const STAFF = {
  id: "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
  name: "Staff Test",
};
const RUNNING: LiveStatus = { ...IDLE_STATUS, isRunning: true };

/** 15 Oct live room run: the echo has no requestId; each member posts once with `author`. */
const echo = userRow(1, "Reply with exactly: ROOM-OK", { clientNonce: "m-1" });
const memberReply = (
  seq: number,
  author: typeof PROBE,
  content: string,
  requestId: string,
) => sendMessageRow(seq, { type: "text", content }, requestId, seq, { author });

describe("room replies", () => {
  it("parse the member who wrote each reply", () => {
    const [reply] = parseTranscriptEntries([
      memberReply(2, PROBE, "ROOM-OK", "post:348"),
    ]);
    expect(reply?.kind === "reply" && reply.author).toEqual(PROBE);
  });

  it("keep the room running between members", () => {
    const rows = [echo, memberReply(2, PROBE, "ROOM-OK", "post:348")];
    expect(summary(rows, RUNNING)).toBe("running:target-active");
  });

  it("list every member's reply once the room is idle", () => {
    const rows = [
      echo,
      memberReply(2, PROBE, "ROOM-OK", "post:348"),
      memberReply(3, STAFF, "ROOM-OK too", "post:7b3"),
    ];
    const v = verdict(rows, IDLE_STATUS);
    expect(
      v.status === "done" && [v.finalReply, v.replies.map((r) => r.author)],
    ).toEqual(["Probe: ROOM-OK\nStaff Test: ROOM-OK too", [PROBE, STAFF]]);
  });
});
