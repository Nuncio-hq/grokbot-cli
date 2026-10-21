import {
  IDLE_STATUS,
  type LiveStatus,
  parseAgentStatusesResponse,
  type TurnSettlement,
} from "./agent-status.js";
import type { JsonObject, ServerTransport } from "./contracts.js";
import { readDelegationTargets } from "./delegation-reads.js";
import type {
  DelegationContext,
  DelegationReport,
  DelegationTarget,
} from "./delegations.js";
import {
  type DoneVerdict,
  type ReplyEntry,
  reportTurn,
  type TurnReport,
} from "./done-rule.js";
import type { FetchLike } from "./server-transport.js";
import { asJsonObject, parseSeq, type TranscriptEntry } from "./transcript.js";
import {
  readTranscriptSince,
  type TranscriptCursor,
} from "./transcript-stream.js";
import { findTurn } from "./turn-model.js";
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

interface WaitSessionConfig {
  readonly server: ServerTransport;
  readonly job: WaitJob;
  readonly signal: AbortSignal;
  readonly backlogLimit: number;
  readonly fetch?: FetchLike;
  /** Called with every verdict worth showing: running ones as seen, the final one once. */
  readonly report: (verdict: DoneVerdict) => void;
  /** New rows (or newer versions) for the target arrived. */
  readonly onNewRows: () => void;
  /** Clock for the subagent-list throttle. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A successful subagent list is reused at least this long, and always when it carries no lease. */
const SUBAGENT_READ_MIN_MS = 5_000;

/** A leased list is reused until its earliest lease, but never longer than this. */
const SUBAGENT_READ_MAX_MS = 60_000;

/** While a delegation to another bot is open, read that bot again this often. */
const DELEGATE_POLL_MS = 5_000;

/** A finite number, or a proto int64 sent as a digit string. */
function readMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** What one ListGrokBotSubagents body tells the wait. */
interface SubagentList {
  /** `startedAtMs` of each running subagent. */
  readonly startedAtMs: readonly number[];
  /**
   * The earliest `freshUntilMs` among the subagents that carry a lease (above 0), in
   * epoch ms. Undefined when none does: 0 or an absent field means no lease.
   */
  readonly leaseEndsAtMs: number | undefined;
}

/**
 * The running subagents from ListGrokBotSubagents. Undefined when the body is not a
 * list, so the Done Rule keeps waiting. An empty object means none are running.
 * A lease that is not a number is ignored: the list is still good.
 */
function parseSubagentList(raw: unknown): SubagentList | undefined {
  const body = asJsonObject(raw);
  if (!body) return undefined;
  if (body.subagents === undefined)
    return { startedAtMs: [], leaseEndsAtMs: undefined };
  if (!Array.isArray(body.subagents)) return undefined;
  const startedAtMs: number[] = [];
  let leaseEndsAtMs: number | undefined;
  for (const item of body.subagents) {
    const row: JsonObject | undefined = asJsonObject(item);
    const started = row && readMs(row.startedAtMs);
    if (row === undefined || started === undefined) return undefined;
    startedAtMs.push(started);
    const lease = readMs(row.freshUntilMs);
    if (lease !== undefined && lease > 0)
      leaseEndsAtMs =
        leaseEndsAtMs === undefined ? lease : Math.min(leaseEndsAtMs, lease);
  }
  return { startedAtMs, leaseEndsAtMs };
}

/** How long a list read at `now` may be reused: until its earliest lease, within the bounds. */
function reuseWindowMs(leaseEndsAtMs: number | undefined, now: number): number {
  if (leaseEndsAtMs === undefined) return SUBAGENT_READ_MIN_MS;
  return Math.min(
    SUBAGENT_READ_MAX_MS,
    Math.max(SUBAGENT_READ_MIN_MS, leaseEndsAtMs - now),
  );
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
  /**
   * `now()` until which the last successful list is reused. Undefined when there is
   * nothing to reuse.
   */
  #subagentReuseUntilMs: number | undefined;
  /** True when the last successful list carried a lease, so it is read again when it runs out. */
  #subagentLeased = false;
  /** Set while the previous status had `hasRunningSubagents`, so a rising edge reads at once. */
  #subagentsWereRunning = false;
  /** `startedAtMs` of every subagent a list read showed since the wait began, finished ones included. */
  readonly #subagentsSeen = new Set<number>();
  /** A list read failed while subagents ran, so when they started is unknown. */
  #subagentStartUnknown = false;
  /** True when the current status read the list, so a finish does not need another read. */
  #subagentReadForStatus = false;
  /** Reads of the bots our bot delegated to (see delegations.ts); empty when none are followed. */
  #delegateTargets: ReadonlyMap<string, DelegationTarget> = new Map();
  /** The delegates and the contested ones the last read covered, to notice a change. */
  #delegateKey = "";
  /** `now()` when the delegates are due for the next read; undefined when none wait. */
  #delegatesNextAtMs: number | undefined;
  /** Counts changes of our bot's rows and status, so a delegate read can tell it is the newer. */
  #changes = 0;
  /** The `#changes` value the last delegate read started at. */
  #delegatesAtChange = -1;
  /** Every settlement seen on a status of this bot, by turnId: the server clears it when the next run starts. */
  readonly #settlements = new Map<string, TurnSettlement>();
  /** What the last `settle()` found about the server's settlement of the turn. */
  #report: TurnReport | undefined;
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
    if (added) {
      this.#changes++;
      this.#config.onNewRows();
    }
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
    const added = this.addRows(page.entries);
    await this.syncDelegates();
    await this.confirmSubagentList();
    return added;
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
   * run, also reads when each one started. A rising edge reads at once; otherwise
   * a successful list is reused until its earliest lease (`freshUntilMs`), at least
   * `SUBAGENT_READ_MIN_MS` and at most `SUBAGENT_READ_MAX_MS`, or for
   * `SUBAGENT_READ_MIN_MS` when it has no lease. A failed read leaves that list
   * unknown and is not reused. A reused list is read again before a verdict other
   * than running.
   */
  async recordStatus(status: LiveStatus): Promise<void> {
    this.status = status;
    const seen = status.lastTurnSettlement;
    if (
      seen &&
      seen.settledAtMs >= (this.#settlements.get(seen.turnId)?.settledAtMs ?? 0)
    )
      this.#settlements.set(seen.turnId, seen);
    this.#changes++;
    await this.#readSubagentStarts();
    await this.confirmSubagentList();
  }

  /** `now()` when a leased list runs out and must be read again; undefined when none waits. */
  get subagentsDueAtMs(): number | undefined {
    return this.status.hasRunningSubagents && this.#subagentLeased
      ? this.#subagentReuseUntilMs
      : undefined;
  }

  /** The list of a lease-bearing read has run out, with no status update to trigger the read. */
  subagentsDue(): boolean {
    const due = this.subagentsDueAtMs;
    return due !== undefined && this.#now() >= due;
  }

  /**
   * Reads the list again when a lease has run out, so a subagent that finished or
   * whose lease lapsed stops holding the wait without the next status update. A
   * failed read leaves the list unknown, as after a status update.
   */
  async syncSubagents(): Promise<void> {
    if (!this.subagentsDue()) return;
    await this.#fetchSubagentStarts(this.#now());
  }

  #now(): number {
    return this.#config.now?.() ?? Date.now();
  }

  async #readSubagentStarts(): Promise<void> {
    if (!this.status.hasRunningSubagents) {
      this.#clearSubagentList();
      this.#subagentsWereRunning = false;
      this.#subagentReadForStatus = true;
      return;
    }
    const now = this.#now();
    const rising = !this.#subagentsWereRunning;
    this.#subagentsWereRunning = true;
    const reuseUntil = this.#subagentReuseUntilMs;
    if (!rising && reuseUntil !== undefined && now < reuseUntil) {
      this.#subagentReadForStatus = false;
      return;
    }
    await this.#fetchSubagentStarts(now);
  }

  #clearSubagentList(): void {
    this.#subagentStartedAtMs = undefined;
    this.#subagentReuseUntilMs = undefined;
    this.#subagentLeased = false;
  }

  /** Reads the list, bypassing the reuse window. A failed read stays unknown. */
  async #fetchSubagentStarts(now: number): Promise<void> {
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
      const list = parseSubagentList(raw);
      if (list === undefined) {
        this.#clearSubagentList();
        this.#subagentStartUnknown = true;
      } else {
        this.#subagentStartedAtMs = list.startedAtMs;
        for (const start of list.startedAtMs) this.#subagentsSeen.add(start);
        this.#subagentReuseUntilMs =
          now + reuseWindowMs(list.leaseEndsAtMs, now);
        this.#subagentLeased = list.leaseEndsAtMs !== undefined;
      }
    } catch (error) {
      if (signal.aborted || isFatal(error)) throw error;
      this.#clearSubagentList();
      this.#subagentStartUnknown = true;
    }
    this.#subagentReadForStatus = true;
  }

  /**
   * A cached list must not end the turn. When the Done Rule would return anything
   * other than running while subagents are on and this status did not read the
   * list, read it again and keep that result. Running verdicts stay throttled.
   */
  async confirmSubagentList(): Promise<void> {
    if (!this.status.hasRunningSubagents || this.#subagentReadForStatus) return;
    if (this.#evaluate().verdict.status === "running") return;
    await this.#fetchSubagentStarts(this.#now());
  }

  #entries(): TranscriptEntry[] {
    return this.rows
      .entries()
      .map((e) =>
        e.kind === "blob" ? (this.#blobReplies.get(e.blobHash) ?? e) : e,
      );
  }

  #evaluate(): TurnReport {
    const { sentMessageId, busyAtSend } = this.#config.job;
    const { status } = this;
    const subagentStartedAtMs = this.#subagentStartedAtMs;
    const delegations = this.#delegationContext();
    return reportTurn({
      entries: this.#entries(),
      sentMessageId,
      status,
      settlements: this.#settlements.values(),
      subagentsSeen: {
        startedAtMs: [...this.#subagentsSeen],
        unknownStart: this.#subagentStartUnknown,
      },
      ...(busyAtSend && { busyAtSend }),
      ...(status.hasRunningSubagents &&
        subagentStartedAtMs !== undefined && { subagentStartedAtMs }),
      ...(delegations && { delegations }),
    });
  }

  /** The turn's delegations, paired with the delegates' reads when `ctx` holds them. */
  #delegations(ctx?: DelegationContext): DelegationReport | undefined {
    const { sentMessageId, busyAtSend } = this.#config.job;
    return findTurn(this.#entries(), sentMessageId, busyAtSend, ctx)
      ?.delegations;
  }

  /**
   * Keeps the reads of the bots our bot delegated to in step with its rows (see
   * delegations.ts). Nothing is read while no open delegation has an id to follow, so a
   * wait without tracked delegations costs no extra call. Otherwise the delegates are read
   * (live status of all, then recent rows of the idle ones and of those several
   * delegations went to) when the set changed, when `force` is set, or when the poll or a
   * grace came due. A failed read leaves those delegations paired by agent, as before,
   * and is tried again at the next poll.
   */
  async syncDelegates(force = false): Promise<void> {
    const plan = this.#delegations();
    const ids = plan?.targets ?? [];
    if (plan === undefined || ids.length === 0) {
      this.#delegateTargets = new Map();
      this.#delegateKey = "";
      this.#delegatesNextAtMs = undefined;
      this.#delegatesAtChange = this.#changes;
      return;
    }
    const key = `${[...ids].sort()}|${[...plan.contested].sort()}`;
    const now = this.#now();
    const due =
      this.#delegatesNextAtMs !== undefined && now >= this.#delegatesNextAtMs;
    if (!force && key === this.#delegateKey && !due) return;
    const { server, signal } = this.#config;
    const changes = this.#changes;
    try {
      const raw = await abortable(
        server.call("ListGrokBotAgentStatuses", { agentIds: ids }, { signal }),
        signal,
      );
      this.#delegateTargets = await readDelegationTargets(
        server,
        ids,
        parseAgentStatusesResponse(raw),
        now,
        signal,
        plan.contested,
      );
    } catch (error) {
      if (signal.aborted || isFatal(error)) throw error;
      this.#delegateTargets = new Map();
    }
    this.#delegateKey = key;
    this.#delegatesAtChange = changes;
    this.#delegatesNextAtMs = this.#nextDelegatePoll(now);
  }

  /** When to read the delegates next: a poll after `readAtMs`, or sooner when a grace ends. */
  #nextDelegatePoll(readAtMs: number): number | undefined {
    const waiting = (
      this.#delegations(this.#delegationContext())?.open ?? []
    ).filter((d) => d.targetId !== undefined && d.state.kind !== "released");
    if (waiting.length === 0) return undefined;
    const graces = waiting.flatMap((d) =>
      d.state.kind === "grace" ? [d.state.atMs] : [],
    );
    return Math.min(readAtMs + DELEGATE_POLL_MS, ...graces);
  }

  #delegationContext(): DelegationContext | undefined {
    return this.#delegateTargets.size === 0
      ? undefined
      : { selfId: this.agentId, targets: this.#delegateTargets };
  }

  /** True when delegates were read and our bot's rows or status changed since. */
  #delegatesStale(): boolean {
    return (
      this.#delegateTargets.size > 0 &&
      this.#delegatesAtChange !== this.#changes
    );
  }

  /** `now()` when the delegates are due for another read; undefined when none wait. */
  get delegatesDueAtMs(): number | undefined {
    return this.#delegatesNextAtMs;
  }

  /** The delegates' poll, or the grace of one, has come due. */
  delegatesDue(): boolean {
    const due = this.#delegatesNextAtMs;
    return due !== undefined && this.#now() >= due;
  }

  /**
   * A delegate read older than our bot's newest rows or status must not end the turn: a
   * delegation released on it may since have been answered. When the Done Rule would
   * return anything other than running on such a read, read the delegates again.
   */
  async confirmDelegates(): Promise<void> {
    if (!this.#delegatesStale()) return;
    if (this.#evaluate().verdict.status === "running") return;
    await this.syncDelegates(true);
  }

  /** Evaluates the Done Rule; a running verdict is reported at once, others only by finish. */
  settle(): DoneVerdict {
    this.#report = this.#evaluate();
    const { verdict } = this.#report;
    if (verdict.status === "running") this.#config.report(verdict);
    return verdict;
  }

  /**
   * As of the last `settle()`: the server settled the turn's latest run, so a verdict
   * other than running needs no quiet window (the caller still reads the rows again).
   */
  get settled(): boolean {
    return this.#report?.settled ?? false;
  }

  /**
   * As of the last `settle()`: the error or cancellation the server ended the turn with
   * while no reply answers it. Only set with a running, awaiting-final-reply verdict.
   */
  get failure(): TurnSettlement | undefined {
    return this.#report?.failure;
  }

  /**
   * Reads a final reply stored as a blob (once per hash), then settles again: the body
   * may show the blob belongs to another run, so the turn can go back to running.
   */
  async finish(verdict: SettledVerdict): Promise<DoneVerdict> {
    const staleDelegates = this.#delegatesStale();
    const stale =
      (this.status.hasRunningSubagents && !this.#subagentReadForStatus) ||
      staleDelegates;
    await this.confirmSubagentList();
    await this.confirmDelegates();
    const hash = "blobHash" in verdict ? verdict.blobHash : undefined;
    let final: DoneVerdict = stale ? this.settle() : verdict;
    if (
      final.status !== "running" &&
      hash !== undefined &&
      !this.#blobReplies.has(hash)
    ) {
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
