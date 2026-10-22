import { describe, expect, it } from "vitest";
import {
  botsServer,
  heldAndUnanswered,
  inboundRow,
  longHandoff,
  noteRow,
  outboundRow,
  ownerRow,
  PRIMARY,
  STAFF,
  twoHandoffs,
} from "./fixtures/handoff-traces.js";
import {
  assistantRow,
  delegateReplyRow,
  withEntryId,
} from "./fixtures/wire-entries.js";
import { snapshotBeforeSend } from "./job-send-snapshot.js";

const busy = async (
  agentId: string,
  rows: Parameters<typeof botsServer>[0],
  live: Parameters<typeof botsServer>[1] = {},
) => {
  const { server, log } = botsServer(rows, live);
  const { botBusy } = await snapshotBeforeSend(server, agentId, []);
  return { botBusy, log };
};

describe("snapshotBeforeSend follows each hand-off by its ids", () => {
  it("does not count a held hand-off or a handled one as busy once the grace passed", async () => {
    const trace = heldAndUnanswered(Date.now() - 60_000);
    const { botBusy, log } = await busy(STAFF.id, {
      [STAFF.id]: trace.senderRows,
      ...trace.others,
    });
    expect(botBusy).toBe(false);
    expect(
      log.filter((c) => c.method === "ListGrokBotTranscriptEntries").length,
    ).toBe(2);
  });

  it("is busy inside the grace and while the receiver works or waits on the owner", async () => {
    const fresh = heldAndUnanswered(Date.now() - 6_000);
    expect(
      (
        await busy(STAFF.id, {
          [STAFF.id]: fresh.senderRows,
          ...fresh.others,
        })
      ).botBusy,
    ).toBe(true);
    const old = heldAndUnanswered(Date.now() - 60_000);
    for (const live of [{ isRunning: true }, { awaiting: "approval" }]) {
      expect(
        (
          await busy(
            STAFF.id,
            { [STAFF.id]: old.senderRows, ...old.others },
            { [PRIMARY.id]: live },
          )
        ).botBusy,
      ).toBe(true);
    }
  });

  it("is busy while an answer is on its way, and idle once it has landed", async () => {
    const trace = longHandoff(Date.now() - 80_000);
    const waiting = await busy(PRIMARY.id, {
      [PRIMARY.id]: trace.upToNote,
      ...trace.others,
    });
    expect(waiting.botBusy).toBe(true);
    const landed = await busy(PRIMARY.id, {
      [PRIMARY.id]: trace.senderRows,
      ...trace.others,
    });
    expect(landed.botBusy).toBe(false);
  });

  it("does not wait for an answer that never reached the sender once the grace passed", async () => {
    const trace = longHandoff(Date.now() - 120_000);
    const { botBusy } = await busy(PRIMARY.id, {
      [PRIMARY.id]: trace.upToNote,
      ...trace.others,
    });
    expect(botBusy).toBe(false);
  });

  it("keeps two hand-offs to one bot apart", async () => {
    const half = twoHandoffs(Date.now() - 120_000, ["b"]);
    const stillOpen = await busy(
      PRIMARY.id,
      { [PRIMARY.id]: half.senderRows, ...half.others },
      { [STAFF.id]: { isRunning: true } },
    );
    expect(stillOpen.botBusy).toBe(true);
    const both = twoHandoffs(Date.now() - 120_000, ["b", "a"]);
    const closed = await busy(PRIMARY.id, {
      [PRIMARY.id]: both.senderRows,
      ...both.others,
    });
    expect(closed.botBusy).toBe(false);
  });

  it("reads no other bot when no hand-off is open", async () => {
    const trace = longHandoff(Date.now() - 120_000);
    const { log } = await busy(PRIMARY.id, {
      [PRIMARY.id]: trace.senderRows,
      ...trace.others,
    });
    expect(
      log.map((c) => [c.method, c.body.agentId ?? c.body.agentIds]),
    ).toEqual([
      ["ListGrokBotTranscriptEntries", PRIMARY.id],
      ["ListGrokBotAgentStatuses", [PRIMARY.id]],
    ]);
  });

  it("never counts a running cloud agent as busy, only its landed report until the bot answers it", async () => {
    const cloud = {
      id: "bc-00000000-0000-4000-8000-0000000000aa",
      name: "bc-00000000-0000-4000-8000-0000000000aa",
    };
    const now = Date.now();
    const launched = [
      ownerRow(10, "Start a cloud agent.", "cloud-1", "rs-1", now - 32_000),
      withEntryId(
        assistantRow(11, "Count the files.", {
          toAgent: { ...cloud, kind: "cloud-agent" },
          requestId: "rs-1",
          timestampMs: now - 30_000,
        }),
        "agent-outbound-ff0001",
      ),
      noteRow(12, "Started.", "rs-1", now - 29_000),
    ];
    const reported = [
      ...launched,
      delegateReplyRow(13, "Counted 3.", cloud, { clientNonce: "ff0002" }),
    ];
    const answered = [
      ...reported,
      noteRow(14, "FINAL: 3 files", "rs-2", now - 1_000),
    ];
    const states = [];
    for (const rows of [launched, reported, answered])
      states.push((await busy(PRIMARY.id, { [PRIMARY.id]: rows })).botBusy);
    expect(states).toEqual([false, true, false]);
  });

  it("is busy while a landed hand-off answer is fresh, and idle once the bot handled it without a reply", async () => {
    const now = Date.now();
    const at = (landedAgoMs: number) => {
      const rows = [
        ownerRow(10, "Ask.", "m-1", "rs-1", now - 90_000),
        outboundRow(11, "ab0001", "Please help.", STAFF, "rs-1", now - 89_000),
        noteRow(12, "Asked.", "rs-1", now - 88_000),
        inboundRow(
          13,
          "ab0002",
          "Help is on its way.",
          STAFF,
          "rs-2",
          now - landedAgoMs,
        ),
      ];
      const staff = [
        inboundRow(5, "ab0001", "Please help.", PRIMARY, "rq-1", now - 88_900),
        outboundRow(
          6,
          "ab0002",
          "Help is on its way.",
          PRIMARY,
          "rq-1",
          now - landedAgoMs - 100,
        ),
      ];
      return busy(PRIMARY.id, { [PRIMARY.id]: rows, [STAFF.id]: staff });
    };
    expect([(await at(3_000)).botBusy, (await at(20_000)).botBusy]).toEqual([
      true,
      false,
    ]);
  });

  it("stays busy on the owner's own unanswered message", async () => {
    const now = Date.now();
    const rows = [ownerRow(10, "Are you there?", "m-1", "rs-1", now - 60_000)];
    expect((await busy(PRIMARY.id, { [PRIMARY.id]: rows })).botBusy).toBe(true);
  });
});
