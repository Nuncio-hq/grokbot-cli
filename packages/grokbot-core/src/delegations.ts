import { type AgentRef, isSameAgent } from "./agent-ref.js";
import { isActive, type LiveStatus } from "./agent-status.js";
import { compareSeq, type TranscriptEntry } from "./transcript.js";
import type { UserMessageEntry } from "./turn-sharing.js";

/**
 * A delegation (bot S messaging bot R with SendToAgent) that R will never answer counts
 * as released only on a read of R that began this long after it was sent: a woken
 * delegation shows on R's transcript within about 1 s (live 19 Oct), a held one never
 * does. The delegation's time is the server's, the read's this machine's, as in every
 * other age check here.
 */
export const DELEGATION_GRACE_MS = 10_000;

/** Clock slack between two bots' rows: R's row came 51 ms before S's (live 19 Oct). */
const CLOCK_SLACK_MS = 2_000;

type AssistantEntry = Extract<TranscriptEntry, { kind: "assistant-message" }>;

/**
 * Live 19 Oct: S's transcript gets an assistant row `agent-outbound-<hex>` for the
 * message, R's a user row with `clientNonce: "<hex>"`. R's answer is an assistant row
 * `agent-outbound-<hex2>` to S, which lands on S as a user row with `clientNonce: "<hex2>"`.
 */
const OUTBOUND_ID = /^agent-outbound-(.+)$/;

/** What the reads of a bot S delegated to showed. */
export interface DelegationTarget {
  readonly status: LiveStatus;
  /**
   * Newest rows of its transcript, in seq order, read after `status`. Undefined when none
   * were read: it was not idle, or the read failed.
   */
  readonly rows: readonly TranscriptEntry[] | undefined;
  /**
   * The rows hold every row from this time on: infinite when no timed row is in them.
   * Undefined when they reach the transcript's first row.
   */
  readonly windowStartMs: number | undefined;
  /** When the status read began; the rows were read after it. */
  readonly readAtMs: number;
}

export interface DelegationContext {
  /** The agentId of the bot whose delegations are judged (S). */
  readonly selfId: string;
  /** Reads by agentId. A bot missing here was not read, so its delegations pair by agent. */
  readonly targets: ReadonlyMap<string, DelegationTarget>;
}

/** Where an open delegation stands. */
export type DelegationState =
  /** The ids cannot tell (no reads of R, unusable rows, a chain deeper than one level). */
  | { readonly kind: "by-agent" }
  /** R is running, awaiting the owner, or waits on a delegation of its own. */
  | { readonly kind: "working" }
  /** R will send nothing, which a read that begins at `atMs` or later confirms. */
  | { readonly kind: "grace"; readonly atMs: number }
  /** Held, or handled without an answer: R will send nothing back, so nothing is awaited. */
  | { readonly kind: "released" };

interface Delegation {
  /** The entryId of S's own row for it. */
  readonly entryId: string;
  readonly to: AgentRef;
  readonly atMs: number | undefined;
  /** Set when R's own rows can tell this delegation's fate: a bot, with an id to follow. */
  readonly track:
    | { readonly hex: string; readonly targetId: string }
    | undefined;
}

export interface OpenDelegation {
  /** The entryId of S's own row for it (`agent-outbound-<hex>`). */
  readonly entryId: string;
  readonly to: AgentRef;
  readonly atMs: number | undefined;
  /** The agentId whose reads decide it; undefined when it can only pair by agent. */
  readonly targetId: string | undefined;
  readonly state: DelegationState;
}

export interface DelegationReport {
  /** Delegations with no answer yet, in the order they were sent. */
  readonly open: readonly OpenDelegation[];
  /** Some open delegation is not released: an answer may still come. */
  readonly pending: boolean;
  /** agentIds of the bots an open delegation the ids can follow went to: the ones to read. */
  readonly targets: readonly string[];
  /**
   * The part of `targets` that got two or more delegations: which of them an answer closes
   * is told only by that bot's own rows, whether it is working or idle.
   */
  readonly contested: readonly string[];
}

/** Not running, no subagents, not waiting on the owner or on a box hand-off. */
export function targetIdle(status: LiveStatus): boolean {
  return !isActive(status) && status.awaiting === null && !status.boxHandoff;
}

const sentToSelf = (e: AssistantEntry, selfId: string): boolean =>
  e.toAgent?.id === selfId;

/** The runs of R that belong to one delegation, from R's own rows. */
interface Reach {
  /** Undefined when R's row for the delegation has no requestId, so no run is tied to it. */
  readonly runs: ReadonlySet<string> | undefined;
  /** R delegated on from a run its own delegation opened: deeper than we follow. */
  readonly deeper: boolean;
  /** R has a delegation of its own from the first run that no bot has answered yet. */
  readonly ownOpen: boolean;
}

/**
 * The runs of R that belong to the delegation `delivered` carries: the run of that row
 * (Rq), plus the runs started by the replies to R's own delegations from Rq (paired by
 * agent, as everywhere else): one level deep.
 */
function reachOf(
  rows: readonly TranscriptEntry[],
  delivered: UserMessageEntry,
  selfId: string,
): Reach {
  const rq = delivered.requestId;
  if (rq === undefined)
    return { runs: undefined, deeper: false, ownOpen: false };
  const runs = new Set([rq]);
  const replied = new Set<TranscriptEntry>();
  let ownOpen = false;
  for (const out of rows) {
    if (out.kind !== "assistant-message" || out.requestId !== rq) continue;
    const to = out.toAgent;
    if (!to || sentToSelf(out, selfId)) continue;
    const reply = rows.find(
      (e): e is UserMessageEntry =>
        e.kind === "user-message" &&
        e.fromAgent !== undefined &&
        isSameAgent(to, e.fromAgent) &&
        compareSeq(e.seq, out.seq) > 0 &&
        !replied.has(e),
    );
    if (!reply) {
      ownOpen = true;
      continue;
    }
    replied.add(reply);
    if (reply.requestId !== undefined) runs.add(reply.requestId);
  }
  const deeper = rows.some(
    (e) =>
      e.kind === "assistant-message" &&
      e.toAgent !== undefined &&
      !sentToSelf(e, selfId) &&
      e.requestId !== undefined &&
      e.requestId !== rq &&
      runs.has(e.requestId),
  );
  return { runs, deeper, ownOpen };
}

const deliveredWith = (
  rows: readonly TranscriptEntry[],
  hex: string,
): UserMessageEntry | undefined =>
  rows.find(
    (e): e is UserMessageEntry =>
      e.kind === "user-message" && e.clientNonce === hex,
  );

/** Every run of R that some delegation from S owns, whichever turn of S sent it. */
function claimedRuns(
  rows: readonly TranscriptEntry[],
  selfId: string,
): Set<string> {
  const claimed = new Set<string>();
  for (const e of rows) {
    if (e.kind !== "user-message" || e.fromAgent?.id !== selfId) continue;
    for (const run of reachOf(rows, e, selfId).runs ?? []) claimed.add(run);
  }
  return claimed;
}

const BY_AGENT: DelegationState = { kind: "by-agent" };
const WORKING: DelegationState = { kind: "working" };

/**
 * R is idle. What its rows say of the delegation with nonce `hex` sent at `atMs`: never
 * received (held; the rows must reach back past it to say so), or received, with no
 * delegation of its own from that run left open. A message from one of its runs to S
 * that S has not received waits out the grace from when R wrote it (a woken one lands at
 * once, live 19 Oct; one that never lands was held). A row to S under another
 * delegation's run is not this one's. One under a run no delegation of S owns, or under
 * none, may be, and a row stored as a blob names no addressee or run: the ids cannot
 * tell, so the delegation pairs by agent.
 */
function idleState(
  { windowStartMs }: DelegationTarget,
  rows: readonly TranscriptEntry[],
  hex: string,
  atMs: number,
  selfId: string,
  received: ReadonlySet<string>,
): DelegationState {
  const graceEnd = atMs + DELEGATION_GRACE_MS;
  const delivered = deliveredWith(rows, hex);
  if (!delivered) {
    const reachesBack =
      windowStartMs === undefined || windowStartMs < atMs - CLOCK_SLACK_MS;
    return reachesBack ? { kind: "grace", atMs: graceEnd } : BY_AGENT;
  }
  const { runs, deeper, ownOpen } = reachOf(rows, delivered, selfId);
  if (runs === undefined || deeper) return BY_AGENT;
  if (ownOpen) return WORKING;
  const claimed = claimedRuns(rows, selfId);
  let graceUntil = graceEnd;
  for (const e of rows) {
    if (compareSeq(e.seq, delivered.seq) <= 0) continue;
    const answerId = OUTBOUND_ID.exec(e.entryId)?.[1];
    if (answerId !== undefined && received.has(answerId)) continue;
    if (e.kind === "blob" || e.kind === "unknown") {
      if (answerId !== undefined) return BY_AGENT;
      continue;
    }
    if (e.kind !== "assistant-message" || !sentToSelf(e, selfId)) continue;
    const run = e.requestId;
    if (run !== undefined && runs.has(run)) {
      if (e.timestampMs === undefined) return BY_AGENT;
      graceUntil = Math.max(graceUntil, e.timestampMs + DELEGATION_GRACE_MS);
    } else if (run === undefined || !claimed.has(run)) return BY_AGENT;
  }
  return { kind: "grace", atMs: graceUntil };
}

/** An answer R's rows put under a delegation of S that is not in the ledger. */
const FOREIGN = Symbol("foreign");

/**
 * Pairs the delegations bot S makes with the rows that end them. A delegation without
 * ids to follow (legacy rows, a cloud agent, a bot whose rows were not read) pairs with
 * the next user row from the same agent, as it always did. So does an answer R's rows
 * do not place. A delegation to a bot (`toAgent.kind` agent, row id `agent-outbound-<hex>`)
 * whose rows are in the context ends so:
 *
 * - answered: by our user row from R whose clientNonce is the hex of an R row
 *   `agent-outbound-<hex2>` to S written under the run R took the delegation in (Rq),
 *   or under a run opened from Rq by R's own delegation, one level deep. It closes that
 *   delegation only, and a second answer under the same run closes nothing.
 * - held: R has no row with the delegation's nonce and is idle.
 * - handled, no answer: R has the row, is idle, has no delegation of its own from Rq left
 *   unanswered, and any message of its runs to S that S has not received is older than
 *   the grace. Held and handled count only on a read that began after the grace
 *   (DELEGATION_GRACE_MS), and a held one only when the rows reach back past the
 *   delegation.
 * - still working: anything else on a bot that was read (R running or awaiting the
 *   owner, or waiting on a delegation of its own; inside the grace). An answer under a
 *   run no delegation of S owns, a blob row, a chain deeper than one level: by agent,
 *   as before.
 */
export class DelegationLedger {
  readonly #ctx: DelegationContext | undefined;
  readonly #all: Delegation[] = [];
  readonly #closed = new Set<Delegation>();
  /** clientNonce of every message from another bot that reached S. */
  readonly #received = new Set<string>();

  constructor(ctx?: DelegationContext) {
    this.#ctx = ctx;
  }

  /** Records the message `row` that S sent to `to`. */
  sent(row: AssistantEntry, to: AgentRef): void {
    const hex = OUTBOUND_ID.exec(row.entryId)?.[1];
    const track =
      hex !== undefined && to.id !== undefined && row.toAgentKind === "agent"
        ? { hex, targetId: to.id }
        : undefined;
    this.#all.push({ entryId: row.entryId, to, atMs: row.timestampMs, track });
  }

  /** Notes that our user row `row` from another bot reached S, whoever it answers. */
  receive(row: UserMessageEntry): void {
    if (row.clientNonce !== undefined) this.#received.add(row.clientNonce);
  }

  /**
   * Closes the delegation our user row `row` from `from` answers: the one R's rows place
   * it on, else the oldest open one to that agent. False when it closes none: no
   * delegation to that agent is open, R's rows place it on one already closed (a second
   * answer to it), or under a run of a delegation outside this list, such as one of an
   * earlier turn.
   */
  answer(row: UserMessageEntry, from: AgentRef): boolean {
    const sameAgent = this.#all.filter((d) => isSameAgent(d.to, from));
    const open = sameAgent.filter((d) => !this.#closed.has(d));
    const [oldest] = open;
    if (!oldest) return false;
    const placed = this.#placed(sameAgent, row);
    if (placed === FOREIGN || (placed && this.#closed.has(placed)))
      return false;
    this.#closed.add(placed ?? oldest);
    return true;
  }

  /**
   * The delegation, open or closed, that R's rows show `row` answers: FOREIGN when they
   * put it under a delegation of S that is not in the list, undefined when they do not
   * place it (no rows of R, no such reply row, or no run to follow).
   */
  #placed(
    sameAgent: readonly Delegation[],
    row: UserMessageEntry,
  ): Delegation | typeof FOREIGN | undefined {
    const selfId = this.#ctx?.selfId;
    const tracked = sameAgent.filter((d) => d.track);
    const targetId = tracked[0]?.track?.targetId;
    if (selfId === undefined || targetId === undefined) return undefined;
    const rows = this.#ctx?.targets.get(targetId)?.rows;
    const reply = rows?.find(
      (e): e is AssistantEntry =>
        e.kind === "assistant-message" &&
        e.entryId === `agent-outbound-${row.clientNonce}` &&
        sentToSelf(e, selfId),
    );
    const run = reply?.requestId;
    if (!rows || run === undefined) return undefined;
    const deliveries = tracked.map(
      (d) => d.track && deliveredWith(rows, d.track.hex),
    );
    const owners = tracked.filter((_, i) => {
      const delivered = deliveries[i];
      return (
        delivered !== undefined &&
        reachOf(rows, delivered, selfId).runs?.has(run) === true
      );
    });
    const own = owners.find((d) => !this.#closed.has(d)) ?? owners[0];
    if (own) return own;
    // Foreign only when every delivery of ours is in view: a missing one may own the run.
    const allInView = deliveries.every((d) => d !== undefined);
    return allInView && claimedRuns(rows, selfId).has(run)
      ? FOREIGN
      : undefined;
  }

  #state({ track, atMs }: Delegation): DelegationState {
    const ctx = this.#ctx;
    const target = track && ctx?.targets.get(track.targetId);
    if (!track || !ctx || !target) return BY_AGENT;
    if (!targetIdle(target.status)) return WORKING;
    if (!target.rows || atMs === undefined) return BY_AGENT;
    const state = idleState(
      target,
      target.rows,
      track.hex,
      atMs,
      ctx.selfId,
      this.#received,
    );
    return state.kind === "grace" && target.readAtMs >= state.atMs
      ? { kind: "released" }
      : state;
  }

  report(): DelegationReport {
    const targets = new Set<string>();
    const open = this.#all
      .filter((d) => !this.#closed.has(d))
      .map((d): OpenDelegation => {
        if (d.track) targets.add(d.track.targetId);
        return {
          entryId: d.entryId,
          to: d.to,
          atMs: d.atMs,
          targetId: d.track?.targetId,
          state: this.#state(d),
        };
      });
    const sent = this.#all.flatMap((d) => (d.track ? [d.track.targetId] : []));
    return {
      open,
      pending: open.some((d) => d.state.kind !== "released"),
      targets: [...targets],
      contested: [...targets].filter(
        (id) => sent.filter((sentTo) => sentTo === id).length > 1,
      ),
    };
  }
}

/** Runs the delegations in `entries` (seq order) through a ledger and reports where they stand. */
export function scanDelegations(
  entries: readonly TranscriptEntry[],
  ctx?: DelegationContext,
): DelegationReport {
  const ledger = new DelegationLedger(ctx);
  for (const e of entries) if (e.kind === "user-message") ledger.receive(e);
  for (const e of entries) {
    if (e.kind === "assistant-message" && e.toAgent) ledger.sent(e, e.toAgent);
    if (e.kind === "user-message" && e.fromAgent) ledger.answer(e, e.fromAgent);
  }
  return ledger.report();
}
