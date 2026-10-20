import { describe, expect, it } from "vitest";
import type { JsonObject } from "./contracts.js";
import { GrokBotError } from "./contracts.js";
import {
  botsServer,
  chainedHandoff,
  heldAndUnanswered,
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
import { waitForDone } from "./wait-for-done.js";

const OPTIONS = { reconnectDelayMs: 1, quietWindowMs: 20 } as const;

const jobOf = (agentId: string, sentMessageId: string) => ({
  agentId,
  sentMessageId,
  baselineUpdatedSeq: "0",
});

/** The agentIds of the status reads and the agents whose rows were read, in order. */
function reads(log: readonly { method: string; body: JsonObject }[]) {
  return log.flatMap((c) =>
    c.method === "ListGrokBotAgentStatuses"
      ? [`status:${String(c.body.agentIds)}`]
      : c.method === "ListGrokBotTranscriptEntries"
        ? [`rows:${String(c.body.agentId)}`]
        : [],
  );
}

const rowsFrame = (agentId: string, ...entries: unknown[]) => ({
  rows: { agentId, entries },
});
const stateFrame = (agentId: string, live: JsonObject) => ({
  agentState: { live: [{ agentId, ...live }] },
});

describe("waitForDone follows each hand-off by its ids", () => {
  it("ends the 92 s hand-off with the FINAL reply, reading only our bot", async () => {
    const trace = longHandoff(Date.now() - 120_000);
    const { server, log } = botsServer({
      [PRIMARY.id]: trace.senderRows,
      ...trace.others,
    });
    const result = await waitForDone({
      server,
      job: jobOf(PRIMARY.id, trace.messageId),
      timeoutMs: 3_000,
      ...OPTIONS,
    });
    expect(result.status === "done" && result.finalReply).toBe("FINAL: DONE-A");
    expect(reads(log)).toEqual([`status:${PRIMARY.id}`, `rows:${PRIMARY.id}`]);
  });

  it("keeps waiting while the receiver works, then follows its answer to the FINAL reply", async () => {
    const trace = longHandoff(Date.now() - 120_000);
    const live: Record<string, JsonObject> = {
      [PRIMARY.id]: {},
      [STAFF.id]: { isRunning: true },
    };
    const { server, log } = botsServer(
      { [PRIMARY.id]: trace.upToNote, ...trace.others },
      live,
      [
        [
          rowsFrame(PRIMARY.id, ...trace.senderRows.slice(4, 5)),
          stateFrame(PRIMARY.id, { isRunning: true }),
          rowsFrame(PRIMARY.id, ...trace.senderRows.slice(5)),
          stateFrame(PRIMARY.id, {}),
        ],
      ],
    );
    const result = await waitForDone({
      server,
      job: jobOf(PRIMARY.id, trace.messageId),
      timeoutMs: 3_000,
      ...OPTIONS,
    });
    expect(result.status === "done" && result.finalReply).toBe("FINAL: DONE-A");
    // Staff is running, so its status is read once and its rows never are.
    expect(reads(log)).toEqual([
      `status:${PRIMARY.id}`,
      `rows:${PRIMARY.id}`,
      `status:${STAFF.id}`,
      `rows:${PRIMARY.id}`,
    ]);
  });

  it("ends a held hand-off and a handled one once the grace has passed, for two extra reads", async () => {
    const trace = heldAndUnanswered(Date.now() - 60_000);
    const { server, log } = botsServer({
      [STAFF.id]: trace.senderRows,
      ...trace.others,
    });
    const result = await waitForDone({
      server,
      job: jobOf(STAFF.id, trace.messageId),
      timeoutMs: 3_000,
      ...OPTIONS,
    });
    expect(result.status === "done" && result.finalReply).toBe(
      "Sent one held, one woken.",
    );
    expect(reads(log)).toEqual([
      `status:${STAFF.id}`,
      `rows:${STAFF.id}`,
      `status:${PRIMARY.id}`,
      `rows:${PRIMARY.id}`,
    ]);
  });

  it("waits for the grace of a hand-off sent moments ago, then ends", async () => {
    const trace = heldAndUnanswered(Date.now() - 16_500);
    const { server } = botsServer({
      [STAFF.id]: trace.senderRows,
      ...trace.others,
    });
    const started = Date.now();
    const result = await waitForDone({
      server,
      job: jobOf(STAFF.id, trace.messageId),
      timeoutMs: 6_000,
      ...OPTIONS,
    });
    expect(result.status).toBe("done");
    expect(Date.now() - started).toBeGreaterThan(1_000);
  }, 10_000);

  it("pairs a hand-off by agent, as before, while the receiver cannot be read", async () => {
    const trace = heldAndUnanswered(Date.now() - 60_000);
    const { server } = botsServer({
      [STAFF.id]: trace.senderRows,
      ...trace.others,
    });
    const failing = {
      call: (method: string, body: JsonObject, options?: never) =>
        method === "ListGrokBotTranscriptEntries" && body.agentId === PRIMARY.id
          ? Promise.reject(new Error("receiver rows unavailable"))
          : server.call(method, body, options),
      stream: server.stream.bind(server),
    };
    const error = await waitForDone({
      server: failing,
      job: jobOf(STAFF.id, trace.messageId),
      timeoutMs: 400,
      ...OPTIONS,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as Error).message).toContain("pending-delegation");
  });

  it("closes two hand-offs to one bot only by their own answers", async () => {
    // B's answer landed; A is still being worked on, so B's answer must not close it.
    const trace = twoHandoffs(Date.now() - 120_000, ["b"]);
    const staff = (trace.others[STAFF.id] ?? []).slice(0, 3);
    const open = botsServer(
      { [PRIMARY.id]: trace.senderRows, [STAFF.id]: staff },
      { [STAFF.id]: { isRunning: true } },
    );
    const error = await waitForDone({
      server: open.server,
      job: jobOf(PRIMARY.id, trace.messageId),
      timeoutMs: 400,
      ...OPTIONS,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain("pending-delegation");
    // Staff is running, yet its rows were read: two hand-offs went to it.
    expect(reads(open.log)).toContain(`rows:${STAFF.id}`);

    const both = twoHandoffs(Date.now() - 120_000, ["b", "a"]);
    const finished = botsServer({
      [PRIMARY.id]: both.senderRows,
      ...both.others,
    });
    const result = await waitForDone({
      server: finished.server,
      job: jobOf(PRIMARY.id, both.messageId),
      timeoutMs: 3_000,
      ...OPTIONS,
    });
    expect(result.status === "done" && result.finalReply).toBe(
      "FINAL: A and B done",
    );
  });

  it("accepts an answer the receiver wrote one hand-off deep, and waits while its own is open", async () => {
    const trace = chainedHandoff(Date.now() - 120_000, 1, true);
    const landed = botsServer({
      [PRIMARY.id]: [
        ...trace.senderRows,
        noteRow(44, "FINAL: total 7", "rs-2", Date.now() - 80_000),
      ],
      ...trace.others,
    });
    const result = await waitForDone({
      server: landed.server,
      job: jobOf(PRIMARY.id, trace.messageId),
      timeoutMs: 3_000,
      ...OPTIONS,
    });
    expect(result.status === "done" && result.finalReply).toBe(
      "FINAL: total 7",
    );

    const open = chainedHandoff(Date.now() - 120_000, 1);
    const stalled = botsServer({
      [PRIMARY.id]: open.senderRows,
      [STAFF.id]: (open.others[STAFF.id] ?? []).slice(0, 2),
    });
    const error = await waitForDone({
      server: stalled.server,
      job: jobOf(PRIMARY.id, open.messageId),
      timeoutMs: 400,
      ...OPTIONS,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain("pending-delegation");
  });

  it("treats a cloud-agent hand-off exactly as before, with no extra read", async () => {
    const now = Date.now();
    const cloud = {
      id: "bc-00000000-0000-4000-8000-0000000000aa",
      name: "bc-00000000-0000-4000-8000-0000000000aa",
    };
    const rows = [
      ownerRow(10, "Start a cloud agent.", "cloud-1", "rs-1", now - 60_000),
      withEntryId(
        assistantRow(11, "Count the files.", {
          toAgent: { ...cloud, kind: "cloud-agent" },
          requestId: "rs-1",
          timestampMs: now - 59_000,
        }),
        "agent-outbound-ff0001",
      ),
      noteRow(12, "Started.", "rs-1", now - 58_000),
    ];
    const pending = botsServer({ [PRIMARY.id]: rows });
    const error = await waitForDone({
      server: pending.server,
      job: jobOf(PRIMARY.id, "cloud-1"),
      timeoutMs: 400,
      ...OPTIONS,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain("pending-delegation");
    expect(reads(pending.log).every((r) => r.endsWith(PRIMARY.id))).toBe(true);

    const answered = botsServer({
      [PRIMARY.id]: [
        ...rows,
        delegateReplyRow(13, "Counted 3.", cloud, {
          clientNonce: "ff0002",
          requestId: "rs-2",
          timestampMs: now - 20_000,
        }),
        noteRow(14, "FINAL: 3 files", "rs-2", now - 19_000),
      ],
    });
    const result = await waitForDone({
      server: answered.server,
      job: jobOf(PRIMARY.id, "cloud-1"),
      timeoutMs: 3_000,
      ...OPTIONS,
    });
    expect(result.status === "done" && result.finalReply).toBe(
      "FINAL: 3 files",
    );
  });

  it("does not release a hand-off the receiver has not yet handled while it runs", async () => {
    const now = Date.now();
    const rows = [
      ownerRow(10, "Ask Primary Test.", "wake-1", "rs-1", now - 60_000),
      outboundRow(11, "ab0001", "Please help.", PRIMARY, "rs-1", now - 59_000),
      noteRow(12, "Asked.", "rs-1", now - 58_000),
    ];
    const { server } = botsServer(
      { [STAFF.id]: rows, [PRIMARY.id]: [] },
      {
        [PRIMARY.id]: { isRunning: true },
      },
    );
    const error = await waitForDone({
      server,
      job: jobOf(STAFF.id, "wake-1"),
      timeoutMs: 400,
      ...OPTIONS,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toContain("pending-delegation");
  });
});
