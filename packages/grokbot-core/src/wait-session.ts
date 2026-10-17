import {
  IDLE_STATUS,
  type LiveStatus,
  parseAgentStatusesResponse,
} from "./agent-status.js";
import type { JsonObject, ServerTransport } from "./contracts.js";
import {
  type DoneVerdict,
  evaluateDoneRule,
  type ReplyEntry,
} from "./done-rule.js";
import type { FetchLike } from "./server-transport.js";
import { asJsonObject, parseSeq, type TranscriptEntry } from "./transcript.js";
import {
  readTranscriptSince,
  type TranscriptCursor,
} from "./transcript-stream.js";
import type { BusyAtSend } from "./turn-sharing.js";
import { readBlobReply } from "./wait-blob.js";
import { abortable, isFatal } from "./wait-reconnect.js";
import { RowStore } from "./wait-row-store.js";

export type SettledVerdict = Exclude<DoneVerdict, { status: "running" }>;

/** The part of a JobRecord the wait needs. */
export interface WaitJob {
  readonly agentId: string;
  readonly sentMessageId: string;
  readonly baselineUpdatedSeq: string;
  /** Busy-at-send records of this and other known messages (see turn-sharing.ts). */
  readonly busyAtSend?: BusyAtSend;
}

export interface WaitSessionConfig {
  readonly server: ServerTransport;
  readonly job: WaitJob;
  readonly signal: AbortSignal;
  readonly backlogLimit: number;
  readonly fetch?: FetchLike;
  /** Called with every verdict worth showing: running ones as seen, the final one once. */
  readonly report: (verdict: DoneVerdict) => void;
  /** New rows (or newer versions) for the target arrived. */
  readonly onNewRows: () => void;
}

/** A finite number, or a proto int64 sent as a digit string. */
function readMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Start times from ListGrokBotSubagents. Undefined when the body is not a list,
 * so the Done Rule keeps waiting. An empty object means none are running.
 */
function parseSubagentStartedAtMs(raw: unknown): readonly number[] | undefined {
  const body = asJsonObject(raw);
  if (!body) return undefined;
  if (body.subagents === undefined) return [];
  if (!Array.isArray(body.subagents)) return undefined;
  const times: number[] = [];
  for (const item of body.subagents) {
    const row: JsonObject | undefined = asJsonObject(item);
    const started = row && readMs(row.startedAtMs);
    if (started === undefined) return undefined;
    times.push(started);
  }
  return times;
}

/** What one wait knows about its agent: rows above the baseline, the latest status, read blobs. */
export class WaitSession {
  readonly rows: RowStore;
  status: LiveStatus = IDLE_STATUS;
  readonly #config: WaitSessionConfig;
  readonly #blobReplies = new Map<string, ReplyEntry | null>();
  /**
   * `startedAtMs` of the running subagents. Undefined when unknown: the flag is
   * off, the list was not read, or the read failed.
   */
  #subagentStartedAtMs: readonly number[] | undefined;
  #needsBacklog = true;

  constructor(config: WaitSessionConfig) {
    this.#config = config;
    this.rows = new RowStore(parseSeq(config.job.baselineUpdatedSeq));
  }

  get agentId(): string {
    return this.#config.job.agentId;
  }

  get cursor(): TranscriptCursor {
    return {
      agentId: this.agentId,
      generation: this.rows.generation,
      afterUpdatedSeq: this.rows.cursor,
      sessionId: "",
    };
  }

  /** The next read starts at the baseline again (first read, or after cursorTooOld). */
  get needsBacklog(): boolean {
    return this.#needsBacklog;
  }

  requireBacklog(): void {
    this.#needsBacklog = true;
  }

  addRows(entries: readonly TranscriptEntry[]): boolean {
    const added = this.rows.add(entries);
    if (added) this.#config.onNewRows();
    return added;
  }

  /** Reads rows above the baseline or the cursor; true when any were new. */
  async readRows(): Promise<boolean> {
    const { server, signal, backlogLimit } = this.#config;
    const afterSeq = this.#needsBacklog ? this.rows.baseline : this.rows.cursor;
    const request = { agentId: this.agentId, afterSeq, limit: backlogLimit };
    const page = await abortable(
      readTranscriptSince(server, request, { signal }),
      signal,
    );
    this.#needsBacklog = false;
    this.rows.generation = page.generation;
    return this.addRows(page.entries);
  }

  async refreshStatus(): Promise<void> {
    const { server, signal } = this.#config;
    const raw = await abortable(
      server.call(
        "ListGrokBotAgentStatuses",
        { agentIds: [this.agentId] },
        { signal },
      ),
      signal,
    );
    const status =
      parseAgentStatusesResponse(raw).get(this.agentId) ?? IDLE_STATUS;
    await this.recordStatus(status);
  }

  /**
   * Stores a live status from a status read or a stream frame. While subagents
   * run, also reads when each one started. A failed read leaves that list unknown.
   */
  async recordStatus(status: LiveStatus): Promise<void> {
    this.status = status;
    await this.#readSubagentStarts();
  }

  async #readSubagentStarts(): Promise<void> {
    if (!this.status.hasRunningSubagents) {
      this.#subagentStartedAtMs = undefined;
      return;
    }
    const { server, signal } = this.#config;
    try {
      const raw = await abortable(
        server.call(
          "ListGrokBotSubagents",
          { agentId: this.agentId },
          { signal },
        ),
        signal,
      );
      this.#subagentStartedAtMs = parseSubagentStartedAtMs(raw);
    } catch (error) {
      if (signal.aborted || isFatal(error)) throw error;
      this.#subagentStartedAtMs = undefined;
    }
  }

  /** Evaluates the Done Rule; a running verdict is reported at once, others only by finish. */
  settle(): DoneVerdict {
    const entries = this.rows
      .entries()
      .map((e) =>
        e.kind === "blob" ? (this.#blobReplies.get(e.blobHash) ?? e) : e,
      );
    const { sentMessageId, busyAtSend } = this.#config.job;
    const { status } = this;
    const subagentStartedAtMs = this.#subagentStartedAtMs;
    const verdict = evaluateDoneRule({
      entries,
      sentMessageId,
      status,
      ...(busyAtSend && { busyAtSend }),
      ...(status.hasRunningSubagents &&
        subagentStartedAtMs !== undefined && { subagentStartedAtMs }),
    });
    if (verdict.status === "running") this.#config.report(verdict);
    return verdict;
  }

  /**
   * Reads a final reply stored as a blob (once per hash), then settles again: the body
   * may show the blob belongs to another run, so the turn can go back to running.
   */
  async finish(verdict: SettledVerdict): Promise<DoneVerdict> {
    const hash = "blobHash" in verdict ? verdict.blobHash : undefined;
    let final: DoneVerdict = verdict;
    if (hash !== undefined && !this.#blobReplies.has(hash)) {
      const blob = this.rows
        .entries()
        .find((e) => e.kind === "blob" && e.blobHash === hash);
      const reply =
        blob?.kind === "blob"
          ? await readBlobReply(blob, this.#config)
          : undefined;
      this.#blobReplies.set(hash, reply ?? null);
      final = this.settle();
    }
    this.#config.report(final);
    return final;
  }
}
