import { type LiveStatus, parseAgentStatePayload } from "./agent-status.js";
import type { CallOptions, JsonObject, ServerTransport } from "./contracts.js";
import {
  asJsonObject,
  compareSeq,
  type EntriesPage,
  type Generation,
  maxSeq,
  parseEntriesResponse,
  parseGeneration,
  parseSeq,
  parseTranscriptEntries,
  readString,
  type Seq,
  sortBySeq,
  type TranscriptEntry,
} from "./transcript.js";

export interface TranscriptCursor {
  readonly agentId: string;
  readonly generation: Generation;
  readonly afterUpdatedSeq: Seq;
  readonly sessionId: string;
}

export type StreamEvent =
  | {
      readonly type: "connected";
      readonly streamId: string;
      readonly lifetimeMs: number;
    }
  | {
      readonly type: "rows";
      readonly agentId: string;
      readonly replay: boolean;
      readonly entries: TranscriptEntry[];
    }
  | {
      readonly type: "agent-state";
      readonly agentId: string;
      readonly status: LiveStatus;
      readonly snapshot: boolean;
    }
  | { readonly type: "heartbeat"; readonly serverTimeMs: number }
  | { readonly type: "cursor-too-old"; readonly agentId: string }
  | {
      readonly type: "cleared";
      readonly agentId: string;
      readonly generation: Generation;
    }
  | {
      readonly type: "turn-failed";
      readonly agentId: string;
      readonly raw: JsonObject;
    }
  | {
      readonly type: "unknown";
      readonly frameType: string;
      readonly raw: unknown;
    };

interface ReadSinceRequest {
  readonly agentId: string;
  /** Keep rows whose updatedSeq is above this. */
  readonly afterSeq: Seq | string;
  readonly limit?: number;
  readonly sessionId?: string;
}

/**
 * Reads every row above `afterSeq` with ListGrokBotTranscriptEntries, paging back
 * with beforeSeq until a page is short or reaches the floor.
 */
export async function readTranscriptSince(
  server: ServerTransport,
  request: ReadSinceRequest,
  options?: CallOptions,
): Promise<EntriesPage> {
  const floor = parseSeq(request.afterSeq);
  const limit = request.limit ?? 50;
  const rows = new Map<Seq, TranscriptEntry>();
  let generation = parseGeneration("0");
  let beforeSeq: Seq | undefined;
  for (;;) {
    const body: JsonObject = {
      agentId: request.agentId,
      sessionId: request.sessionId ?? "",
      limit,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    };
    const page = parseEntriesResponse(
      await server.call("ListGrokBotTranscriptEntries", body, options),
    );
    generation = page.generation;
    for (const e of page.entries)
      if (compareSeq(e.updatedSeq, floor) > 0) rows.set(e.seq, e);
    const oldest = page.entries[0]?.seq;
    const reachedFloor = oldest === undefined || compareSeq(oldest, floor) <= 0;
    const stalled =
      beforeSeq !== undefined &&
      oldest !== undefined &&
      compareSeq(oldest, beforeSeq) >= 0;
    if (page.entries.length < limit || reachedFloor || stalled) break;
    beforeSeq = oldest;
  }
  return { generation, entries: sortBySeq([...rows.values()]) };
}

/** Cursor that resumes after everything in `page`, never behind `floor`. */
export function transcriptCursor(
  agentId: string,
  page: EntriesPage,
  floor: Seq | string = "0",
  sessionId = "",
): TranscriptCursor {
  return {
    agentId,
    generation: page.generation,
    afterUpdatedSeq: maxSeq(
      page.entries.map((e) => e.updatedSeq),
      parseSeq(floor),
    ),
    sessionId,
  };
}

const num = (v: unknown): number =>
  Number(typeof v === "string" || typeof v === "number" ? v : 0);
const agentOf = (p: JsonObject): string => readString(p, "agentId") ?? "";

type FrameParser = (payload: JsonObject) => StreamEvent[];

const FRAME_PARSERS: Record<string, FrameParser> = {
  connected: (p) => [
    {
      type: "connected",
      streamId: readString(p, "streamId") ?? "",
      lifetimeMs: num(p.absoluteLifetimeMs),
    },
  ],
  rows: (p) => [
    {
      type: "rows",
      agentId: agentOf(p),
      replay: p.replay === true,
      entries: parseTranscriptEntries(p.entries),
    },
  ],
  agentState: (p) => {
    const { snapshot, statuses } = parseAgentStatePayload(p);
    return [...statuses].map(([agentId, status]) => ({
      type: "agent-state",
      agentId,
      status,
      snapshot,
    }));
  },
  heartbeat: (p) => [{ type: "heartbeat", serverTimeMs: num(p.serverTimeMs) }],
  cursorTooOld: (p) => [{ type: "cursor-too-old", agentId: agentOf(p) }],
  cleared: (p) => [
    {
      type: "cleared",
      agentId: agentOf(p),
      generation: parseGeneration(p.newGeneration),
    },
  ],
  turnFailed: (p) => [{ type: "turn-failed", agentId: agentOf(p), raw: p }],
};

/** Parses one decoded WatchGrokBotTranscripts frame into zero or more events. */
export function parseStreamFrame(frame: unknown): StreamEvent[] {
  const o = asJsonObject(frame);
  const frameType = o ? (Object.keys(o)[0] ?? "") : "";
  const parser = FRAME_PARSERS[frameType];
  const payload = o ? asJsonObject(o[frameType]) : undefined;
  if (!parser || !payload) return [{ type: "unknown", frameType, raw: frame }];
  return parser(payload);
}

/** Follows WatchGrokBotTranscripts until the server ends the stream (about 20 min) or `signal` aborts. */
export async function* watchTranscripts(
  server: ServerTransport,
  cursors: readonly TranscriptCursor[],
  options?: CallOptions,
): AsyncGenerator<StreamEvent> {
  const body = {
    cursors: cursors.map((c) => ({ ...c })),
    includeUnlistedAgents: true,
  };
  for await (const frame of server.stream(
    "WatchGrokBotTranscripts",
    body,
    options,
  )) {
    yield* parseStreamFrame(frame);
  }
}
