import { type AgentRef, isSameAgent } from "./agent-ref.js";
import {
  type CardEntry,
  compareSeq,
  type Seq,
  sortBySeq,
  type TranscriptEntry,
} from "./transcript.js";
import {
  type BusyAtSend,
  isOwnerMessage,
  requestIdOf,
  sharedMessages,
  sharedReason,
} from "./turn-sharing.js";

/** The rows that answer one message we sent, found by run (requestId), not by position. */
export interface Turn {
  /** Rows after our echo that belong to the turn, in seq order. */
  readonly rows: readonly TranscriptEntry[];
  /** A delegation we sent has no reply from that bot yet. */
  readonly hasOpenDelegation: boolean;
  /** Cards of the turn still waiting on the owner: open, and the bot has not resumed past them. */
  readonly openCards: readonly CardEntry[];
  /** Rows of the latest run after its last delegate reply or card: where the final reply lives. */
  readonly tail: readonly TranscriptEntry[];
  /** Our echo's `timestampMs`: when this turn started. */
  readonly startMs: number | undefined;
  /**
   * `timestampMs` of the owner's next message that is not linked to ours.
   * Absent when no such message is in view, so the turn is still open.
   */
  readonly endMs: number | undefined;
  /** The owner sent a message after ours that is not linked to it (see endMs). */
  readonly laterOwnerMessage: boolean;
  /** Set when one run may have answered our message together with another (see turn-sharing). */
  readonly sharedReason?: string;
}

/** Keeps the newest version of each row (highest updatedSeq), in seq order. */
export function newestVersions(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const bySeq = new Map<Seq, TranscriptEntry>();
  for (const e of entries) {
    const held = bySeq.get(e.seq);
    if (!held || compareSeq(e.updatedSeq, held.updatedSeq) > 0)
      bySeq.set(e.seq, e);
  }
  return sortBySeq([...bySeq.values()]);
}

/**
 * The server's turn number in a row id (`t51u`, `t51s0` → `t51`). When the owner resolves
 * a card, the bot resumes in a new run whose rows keep the card's number (live 15 Oct:
 * widget t51s0 in run 0a80…, reply t51s1 in run 2862…). No other run shares a number.
 */
function serverTurnOf(e: TranscriptEntry): string | undefined {
  return /^(t\d+)(?:u|s\d+)$/.exec(e.entryId)?.[1];
}

const NO_RECORDS: BusyAtSend = new Map();

/**
 * The turn's runs start with the runs of the owner messages one run may have answered
 * together with ours (just ours, unless sharedMessages links others). Each delegate reply
 * that closes one of our open delegations starts another, and so does the run the bot
 * resumes in after the owner resolves one of the turn's cards, and a run that continues
 * our server turn number after background work. The latest linked message's
 * run is where the bot answers, so the tail restarts there. A row without a requestId
 * (legacy rows, blobs) counts only before the owner's next unlinked message, and so does
 * every row when the echo has none.
 */
export function findTurn(
  entries: readonly TranscriptEntry[],
  sentMessageId: string,
  busyAtSend: BusyAtSend = NO_RECORDS,
): Turn | undefined {
  const rows = newestVersions(entries);
  const echoAt = rows.findIndex(
    (e) => e.kind === "user-message" && e.clientNonce === sentMessageId,
  );
  const echo = rows[echoAt];
  if (echo?.kind !== "user-message") return undefined;
  const shared = sharedMessages(rows, echoAt, echo, busyAtSend);
  const linked = new Set<TranscriptEntry>(shared.echoes);
  const after = rows.slice(shared.startAt + 1);
  const cut = after.findIndex((e) => isOwnerMessage(e) && !linked.has(e));
  const ownerCut = cut < 0 ? after.length : cut;
  const echoRun = requestIdOf(echo);
  /** The row's run when the turn is keyed by run; undefined means place it by position. */
  const runOf = (e: TranscriptEntry) =>
    echoRun === undefined ? undefined : requestIdOf(e);
  const serverTurnsOfRun = new Map<string, Set<string>>();
  for (const e of after) {
    const run = runOf(e);
    const key = serverTurnOf(e);
    if (run === undefined || key === undefined) continue;
    serverTurnsOfRun.set(
      run,
      (serverTurnsOfRun.get(run) ?? new Set()).add(key),
    );
  }

  const runs = new Set<string | undefined>(shared.echoes.map(runOf));
  /** Server turn numbers of our message and the messages linked to it. */
  const ownServerTurns = new Set(
    shared.echoes.flatMap((e) => serverTurnOf(e) ?? []),
  );
  const open: AgentRef[] = [];
  const cards: CardEntry[] = [];
  const resumed = new Set<CardEntry>();
  const turn: TranscriptEntry[] = [];
  /** The runs the final reply may come from: the latest run, or every linked message's run. */
  let latestRuns = new Set([runOf(rows[shared.startAt] ?? echo)]);
  let tailStart = 0;
  /** Admits `run` when it resumes the bot after cards of the turn; false when it does not. */
  const resumesCards = (run: string): boolean => {
    const keys = serverTurnsOfRun.get(run) ?? new Set();
    const resolved = cards.filter((c) => {
      const key = serverTurnOf(c);
      return key !== undefined && keys.has(key);
    });
    if (resolved.length === 0) return false;
    for (const c of resolved) resumed.add(c);
    runs.add(run);
    latestRuns = new Set([run]);
    tailStart = turn.length;
    return true;
  };
  /**
   * Admits `run` when it continues one of our server turns: live 16 Oct (#217 to #220),
   * after a background subagent finished, the bot answered in a new run (new requestId)
   * under the same turn number as our message. No other message's run shares it.
   */
  const continuesTurn = (run: string): boolean => {
    const keys = serverTurnsOfRun.get(run) ?? new Set();
    if (![...keys].some((k) => ownServerTurns.has(k))) return false;
    runs.add(run);
    latestRuns = new Set([run]);
    tailStart = turn.length;
    return true;
  };
  after.forEach((e, i) => {
    const run = runOf(e);
    const beforeOwner = i < ownerCut;
    if (linked.has(e)) {
      // A later linked message: either linked run may post the answer from here on.
      latestRuns = new Set(shared.echoes.map(runOf));
      tailStart = turn.length;
      return;
    }
    if (e.kind === "user-message" && e.fromAgent) {
      const from = e.fromAgent;
      const closes = open.findIndex((to) => isSameAgent(to, from));
      if (closes < 0 || (run === undefined && !beforeOwner)) return;
      open.splice(closes, 1);
      runs.add(run);
      latestRuns = new Set([run]);
      turn.push(e);
      tailStart = turn.length;
      return;
    }
    if (
      run === undefined
        ? !beforeOwner
        : !runs.has(run) && !resumesCards(run) && !continuesTurn(run)
    )
      return;
    if (e.kind === "assistant-message" && e.toAgent) open.push(e.toAgent);
    turn.push(e);
    if (e.kind !== "card") return;
    cards.push(e);
    // Only what the bot says after a card can answer the turn.
    if (latestRuns.has(run)) tailStart = turn.length;
  });

  const tail = turn.slice(tailStart).filter((e) => {
    const run = runOf(e);
    return run === undefined || latestRuns.has(run);
  });
  const reason = sharedReason(shared, echo);
  const nextOwner = cut < 0 ? undefined : after[cut];
  return {
    rows: turn,
    hasOpenDelegation: open.length > 0,
    openCards: cards.filter((c) => c.open && !resumed.has(c)),
    tail,
    startMs: echo.timestampMs,
    endMs:
      nextOwner && isOwnerMessage(nextOwner)
        ? nextOwner.timestampMs
        : undefined,
    laterOwnerMessage: nextOwner !== undefined,
    ...(reason !== undefined && { sharedReason: reason }),
  };
}
