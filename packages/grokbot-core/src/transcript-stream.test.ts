import { describe, expect, it } from "vitest";
import { IDLE_STATUS } from "./agent-status.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";
import { parseEntriesResponse } from "./transcript.js";
import {
  parseStreamFrame,
  readTranscriptSince,
  type StreamEvent,
  transcriptCursor,
  watchTranscripts,
} from "./transcript-stream.js";

const A = "agent-a";
const B = "agent-b";

function brief(e: StreamEvent): unknown {
  switch (e.type) {
    case "rows":
      return [
        e.type,
        e.agentId,
        e.replay,
        e.entries.map((x) => `${x.seq}:${x.kind}`),
      ];
    case "agent-state":
      return [e.type, e.agentId, e.snapshot, e.status];
    case "unknown":
      return [e.type, e.frameType];
    default:
      return e;
  }
}

describe("watchTranscripts", () => {
  it("asks for every cursor with unlisted agents and yields typed events", async () => {
    const { server, log } = fakeServer({
      streams: [
        [
          {
            connected: {
              streamId: "s-1",
              serverTimeMs: "1",
              absoluteLifetimeMs: "1195000",
            },
          },
          {
            agentState: {
              snapshot: true,
              live: [{ agentId: A, isRunning: true }, { agentId: B }],
              client: [{ agentId: A }],
            },
          },
          {
            boxState: {
              state: { runState: "SAND_BOX_RUN_STATE_HIBERNATED" },
              snapshot: true,
            },
          },
          {
            rows: {
              agentId: A,
              replay: true,
              entries: [textReplyRow(12, "two"), userRow(11, "one")],
            },
          },
          { heartbeat: { serverTimeMs: "1791951871881" } },
          { cursorTooOld: { agentId: A } },
          { cleared: { agentId: A, newGeneration: "4" } },
          { turnFailed: { agentId: A, error: "boom" } },
        ],
      ],
    });
    const cursor = transcriptCursor(
      A,
      parseEntriesResponse({
        generation: "3",
        entries: [textReplyRow(10, "x")],
      }),
    );
    const events: unknown[] = [];
    for await (const e of watchTranscripts(server, [cursor]))
      events.push(brief(e));

    expect(log).toEqual([
      {
        kind: "stream",
        method: "WatchGrokBotTranscripts",
        body: {
          cursors: [
            {
              agentId: A,
              generation: "3",
              afterUpdatedSeq: "10",
              sessionId: "",
            },
          ],
          includeUnlistedAgents: true,
        },
      },
    ]);
    expect(events).toEqual([
      { type: "connected", streamId: "s-1", lifetimeMs: 1_195_000 },
      ["agent-state", A, true, { ...IDLE_STATUS, isRunning: true }],
      ["agent-state", B, true, IDLE_STATUS],
      ["unknown", "boxState"],
      ["rows", A, true, ["11:user-message", "12:reply"]],
      { type: "heartbeat", serverTimeMs: 1_791_951_871_881 },
      { type: "cursor-too-old", agentId: A },
      { type: "cleared", agentId: A, generation: "4" },
      { type: "turn-failed", agentId: A, raw: { agentId: A, error: "boom" } },
    ]);
  });
});

describe("parseStreamFrame", () => {
  it("turns a non-object frame or an empty one into unknown", () => {
    expect(parseStreamFrame("x").map(brief)).toEqual([["unknown", ""]]);
    expect(parseStreamFrame({}).map(brief)).toEqual([["unknown", ""]]);
  });

  it("yields nothing for a client-only agentState frame", () => {
    expect(
      parseStreamFrame({
        agentState: { client: [{ agentId: A, unreadCount: 1 }] },
      }),
    ).toEqual([]);
  });
});

describe("readTranscriptSince", () => {
  const all = [
    userRow(10, "ping", { clientNonce: "m-1" }),
    textReplyRow(11, "a"),
    textReplyRow(12, "b"),
    textReplyRow(13, "c"),
  ];
  const pageBefore = (body: Record<string, unknown>) => {
    const before =
      typeof body.beforeSeq === "string"
        ? Number(body.beforeSeq)
        : Number.POSITIVE_INFINITY;
    const older = [
      textReplyRow(8, "old"),
      textReplyRow(9, "old"),
      ...all,
    ].filter((r) => Number(r.seq) < before);
    return { generation: "2", entries: older.slice(-2).reverse() };
  };

  it("pages back with beforeSeq until it reaches the floor and returns rows after it", async () => {
    const { server, log } = fakeServer({
      calls: { ListGrokBotTranscriptEntries: pageBefore },
    });
    const page = await readTranscriptSince(server, {
      agentId: A,
      afterSeq: "9",
      limit: 2,
    });
    expect([page.generation, page.entries.map((e) => e.seq)]).toEqual([
      "2",
      ["10", "11", "12", "13"],
    ]);
    expect(log.map((c) => c.body.beforeSeq)).toEqual([undefined, "12", "10"]);
    expect(log[0]?.body).toEqual({ agentId: A, sessionId: "", limit: 2 });
  });

  it("stops after one short page", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [textReplyRow(13, "c")] }],
      },
    });
    const page = await readTranscriptSince(server, {
      agentId: A,
      afterSeq: "0",
      limit: 2,
    });
    expect([page.entries.map((e) => e.seq), log.length]).toEqual([["13"], 1]);
  });

  it("stops if the server ignores beforeSeq", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          { entries: [textReplyRow(13, "c"), textReplyRow(12, "b")] },
        ],
      },
    });
    const page = await readTranscriptSince(server, {
      agentId: A,
      afterSeq: "0",
      limit: 2,
    });
    expect([page.entries.map((e) => e.seq), log.length]).toEqual([
      ["12", "13"],
      2,
    ]);
  });
});

describe("transcriptCursor", () => {
  it("starts after the highest updatedSeq, not the highest seq", () => {
    const page = parseEntriesResponse({
      entries: [
        textReplyRow(9, "a"),
        { ...textReplyRow(5, "edited"), updatedSeq: "11" },
      ],
    });
    expect(transcriptCursor(A, page)).toEqual({
      agentId: A,
      generation: "0",
      afterUpdatedSeq: "11",
      sessionId: "",
    });
  });

  it("never moves behind the floor it is given", () => {
    const empty = parseEntriesResponse({ entries: [] });
    expect(transcriptCursor(A, empty, "141").afterUpdatedSeq).toBe("141");
  });
});
