import {
  IDLE_STATUS,
  type LiveStatus,
  parseAgentStatusesResponse,
} from "./agent-status.js";
import type { ServerTransport } from "./contracts.js";
import {
  type DoneVerdict,
  evaluateDoneRule,
  type ReplyEntry,
} from "./done-rule.js";
import type { FetchLike } from "./server-transport.js";
import { parseSeq, type TranscriptEntry } from "./transcript.js";
import {
  readTranscriptSince,
  type TranscriptCursor,
} from "./transcript-stream.js";
import { readBlobReply } from "./wait-blob.js";
import { abortable } from "./wait-reconnect.js";
import { RowStore } from "./wait-row-store.js";

export type SettledVerdict = Exclude<DoneVerdict, { status: "running" }>;

/** The part of a JobRecord the wait needs. */
export interface WaitJob {
  readonly agentId: string;
  readonly sentMessageId: string;
  readonly baselineUpdatedSeq: string;
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

/** What one wait knows about its agent: rows above the baseline, the latest status, read blobs. */
export class WaitSession {
  readonly rows: RowStore;
  status: LiveStatus = IDLE_STATUS;
  readonly #config: WaitSessionConfig;
  readonly #blobReplies = new Map<string, ReplyEntry | null>();
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
    this.status =
      parseAgentStatusesResponse(raw).get(this.agentId) ?? IDLE_STATUS;
  }

  /** Evaluates the Done Rule; a running verdict is reported at once, others only by finish. */
  settle(): DoneVerdict {
    const entries = this.rows
      .entries()
      .map((e) =>
        e.kind === "blob" ? (this.#blobReplies.get(e.blobHash) ?? e) : e,
      );
    const verdict = evaluateDoneRule({
      entries,
      sentMessageId: this.#config.job.sentMessageId,
      status: this.status,
    });
    if (verdict.status === "running") this.#config.report(verdict);
    return verdict;
  }

  /**
   * Reads a final reply stored as a blob (once per hash), then settles again: the body
   * may show the blob belongs to another run, so the turn can go back to running.
   */
  async finish(verdict: SettledVerdict): Promise<DoneVerdict> {
    const hash = verdict.status === "done" ? verdict.blobHash : undefined;
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
