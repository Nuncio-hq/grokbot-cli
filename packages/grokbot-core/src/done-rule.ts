import {
  type BoxHandoff,
  isActive,
  type LiveStatus,
  type TurnSettlement,
} from "./agent-status.js";
import { describeBoxHandoff, describeCard } from "./card-descriptions.js";
import type { DelegationContext } from "./delegations.js";
import {
  type BlobEntry,
  type CardEntry,
  compareSeq,
  isPositionalCardType,
  positionalCardPassed,
  type TranscriptEntry,
} from "./transcript.js";
import { findTurn, type Turn } from "./turn-model.js";
import { settlementOfTurn } from "./turn-settlement.js";
import type { BusyAtSend } from "./turn-sharing.js";

export type { CardEntry } from "./transcript.js";
export type { BusyAtSend } from "./turn-sharing.js";
export type ReplyEntry = Extract<TranscriptEntry, { kind: "reply" }>;

export type RunningReason =
  | "awaiting-echo"
  | "target-active"
  | "subagents-active"
  | "pending-delegation"
  | "awaiting-final-reply";

export type DoneVerdict =
  | { readonly status: "running"; readonly reason: RunningReason }
  | {
      readonly status: "awaiting-approval";
      readonly reason: string;
      readonly cards: readonly CardEntry[];
      /** Set when the bot waits on the owner to do a step on its computer. */
      readonly handoff?: BoxHandoff;
    }
  | {
      readonly status: "done";
      readonly finalReply: string;
      readonly replies: readonly ReplyEntry[];
      /**
       * Set when the final reply is a row stored as a blob whose body was not read;
       * finalReply then holds a marker naming the hash, never an earlier note.
       */
      readonly blobHash?: string;
    }
  | {
      /**
       * The turn ended, but one bot run may have answered our message together with
       * another (see turn-sharing.ts), so no reply can be called ours alone.
       */
      readonly status: "ambiguous";
      readonly reason: string;
      /** Every text reply of the turn in order, blank-line separated (a blob as its marker). */
      readonly replyText: string;
      readonly replies: readonly ReplyEntry[];
      readonly blobHash?: string;
    };

interface DoneRuleInput {
  readonly entries: readonly TranscriptEntry[];
  /** The messageId we sent; the server echoes it back as the user row's clientNonce. */
  readonly sentMessageId: string;
  readonly status: LiveStatus;
  /** Whether the bot was busy when each message we know of was sent; missing means busy. */
  readonly busyAtSend?: BusyAtSend;
  /**
   * `startedAtMs` of the bot's running subagents. Omit when the list is unknown
   * (not read, or the read failed). An empty list means none are running.
   */
  readonly subagentStartedAtMs?: readonly number[];
  /**
   * Reads of the bots our bot delegated to (see delegations.ts). Omit them and every
   * delegation stays open until its bot sends a message back, paired by agent.
   */
  readonly delegations?: DelegationContext;
  /**
   * Every settlement the caller has seen for this bot, in any order. The server clears
   * `live.lastTurnSettlement` when the next run starts, so a wait keeps what it saw;
   * the one in `status` counts too.
   */
  readonly settlements?: Iterable<TurnSettlement>;
  /**
   * Every subagent the caller saw running since it began, finished ones included. A
   * finished subagent wakes the bot in a new run of the same turn (see findTurn), so once
   * one ran in the turn a settlement of an earlier run ends nothing (see reportTurn).
   */
  readonly subagentsSeen?: SubagentsSeen;
}

/** The subagents of one bot that a wait has seen running. */
export interface SubagentsSeen {
  /** `startedAtMs` of each subagent a list read showed. */
  readonly startedAtMs: readonly number[];
  /** A status had subagents running that no list read covered: when they started is unknown. */
  readonly unknownStart: boolean;
}

/** Clock slack before the echo. A subagent this close still counts as ours. */
const SUBAGENT_SLACK_MS = 2_000;

/**
 * True when `startedAtMs` falls inside the turn. Missing bounds err towards
 * waiting: no start means we cannot prove the subagent is earlier, and no end
 * means the turn is still open.
 */
function subagentInTurn(
  startedAtMs: number,
  turnStartMs: number | undefined,
  turnEndMs: number | undefined,
): boolean {
  if (turnEndMs !== undefined && startedAtMs >= turnEndMs) return false;
  if (turnStartMs === undefined) return true;
  return startedAtMs >= turnStartMs - SUBAGENT_SLACK_MS;
}

/**
 * `hasRunningSubagents` is per bot. A known list blocks only when some subagent
 * started during this turn; an unknown list blocks, as before.
 */
function subagentsBlockTurn(
  turn: Turn,
  startedAtMs: readonly number[] | undefined,
): boolean {
  if (startedAtMs === undefined) return true;
  return startedAtMs.some((start) =>
    subagentInTurn(start, turn.startMs, turn.endMs),
  );
}

/** A subagent ran in this turn (or may have): its end can start the run that answers us. */
function subagentsRanInTurn(
  turn: Turn,
  seen: SubagentsSeen | undefined,
): boolean {
  if (seen === undefined) return false;
  return (
    seen.unknownStart ||
    seen.startedAtMs.some((start) =>
      subagentInTurn(start, turn.startMs, turn.endMs),
    )
  );
}

const running = (reason: RunningReason): DoneVerdict => ({
  status: "running",
  reason,
});

function blobReplyMarker(blobHash: string): string {
  return `[reply stored as blob ${blobHash}; run grokbot tail]`;
}

/** What a card asks the owner when live.awaiting gives no reason (card-descriptions.ts). */
function cardReason(card: CardEntry): string {
  return describeCard(card.cardType, card.message).text;
}

type TextReplyEntry = ReplyEntry & {
  readonly reply: Extract<ReplyEntry["reply"], { type: "text" }>;
};

type MediaReply = Extract<
  ReplyEntry["reply"],
  { type: "attachment" | "visualization" }
>;
type MediaReplyEntry = ReplyEntry & { readonly reply: MediaReply };

function isFinalCandidate(e: TranscriptEntry): e is TextReplyEntry | BlobEntry {
  if (e.kind === "blob") return e.entryKind === "send-message";
  return e.kind === "reply" && e.reply.type === "text";
}

const isStreaming = (e: TranscriptEntry): boolean =>
  "isStreaming" in e && e.isStreaming === true;

function isFinishedMedia(e: TranscriptEntry): e is MediaReplyEntry {
  return (
    e.kind === "reply" &&
    (e.reply.type === "attachment" || e.reply.type === "visualization") &&
    !isStreaming(e)
  );
}

/**
 * What stands for a visual or a file in `finalReply`: `[visual: <title>]` or
 * `[file: <fileName>]`, without the name when the row has none. Attachment links may be
 * signed, so only the file name is ever shown.
 */
function mediaReplyMarker(reply: MediaReply): string {
  const [word, label] =
    reply.type === "visualization"
      ? (["visual", reply.title] as const)
      : (["file", reply.fileName] as const);
  const name = label.replace(/\s+/g, " ").trim();
  return name === "" ? `[${word}]` : `[${word}: ${name}]`;
}

/** A room turn: each member's last text reply as `name: text`, in reply order. */
function roomReplyText(replies: readonly ReplyEntry[]): string | undefined {
  const byMember = new Map<string, string>();
  for (const { author, reply } of replies) {
    if (!author || reply.type !== "text") continue;
    const key = author.id ?? author.name;
    byMember.delete(key);
    byMember.set(key, `${author.name}: ${reply.content}`);
  }
  return byMember.size === 0 ? undefined : [...byMember.values()].join("\n");
}

/**
 * Every reply of a shared turn: its text replies in order, then the marker of a final
 * reply that is not text (a blob, a visual or a file).
 */
function sharedReplyText(
  turn: readonly TranscriptEntry[],
  marker: string | undefined,
): string {
  const texts = turn.flatMap((e) =>
    e.kind === "reply" && e.reply.type === "text" ? [e.reply.content] : [],
  );
  if (marker !== undefined) texts.push(marker);
  return texts.join("\n\n");
}

/**
 * The pending box hand-off this turn waits on. The bot resumes after the owner ends a
 * hand-off (EndGrokBotBoxHandoff starts that run), so no reply seen before it is final,
 * and the app's own idle test also requires no hand-off. Live state is per bot, so a
 * hand-off is someone else's only when the owner wrote after us and our turn already has
 * its final reply: a hand-off raised before our message still holds our message back.
 * Known limit: live state does not say which run raised a hand-off, so one raised by a
 * routine run after our turn was answered also holds our job until the owner ends it.
 */
function blockingHandoff(
  status: LiveStatus,
  turn: Turn,
): BoxHandoff | undefined {
  const handoff = status.boxHandoff ?? undefined;
  if (!handoff) return undefined;
  const answered = turn.tail.some(isFinalCandidate);
  return turn.laterOwnerMessage && answered ? undefined : handoff;
}

/**
 * `connector` and `scm-connect` have no closed field (see transcript.ts): the app keys
 * them only by what they ask, and the row never updates when the owner acts. Without
 * `live.awaiting`, such a card blocks only while it is the last bot row of this turn
 * and the bot is not running; a later reply, tool call or message means it has passed.
 * While `live.awaiting` is set, a positional card of this turn still blocks even after
 * a later bot row, because the bot is still waiting on the owner. Several positional
 * cards then collapse to the newest one, so an earlier connect card does not stack.
 */
function blockingCards(turn: Turn, status: LiveStatus): readonly CardEntry[] {
  const newestPositional = turn.openCards.reduce<CardEntry | undefined>(
    (newest, card) => {
      if (!isPositionalCardType(card.cardType)) return newest;
      if (newest === undefined || compareSeq(card.seq, newest.seq) > 0)
        return card;
      return newest;
    },
    undefined,
  );
  return turn.openCards.filter((card) => {
    if (!isPositionalCardType(card.cardType)) return true;
    if (status.awaiting !== null) return card === newestPositional;
    if (positionalCardPassed(card, turn.rows)) return false;
    return !isActive(status);
  });
}

/**
 * Decides whether the turn started by `sentMessageId` has finished.
 * The turn is the runs of our message and of any message one run may have answered with
 * it, plus the runs our delegates' replies and the owner's card answers start (see
 * findTurn); the final reply is the last text (or blob) reply of the latest run. A turn
 * that may be shared ends `ambiguous` with every reply, never `done` with one of them.
 * An open card of the turn awaits the owner once the bot stops, even when live.awaiting
 * is unset (question widgets leave it unset), but live.awaiting alone never makes the
 * turn await: it may belong to a later turn. A connector or repo-connect card closes by
 * position once the bot has moved on (see blockingCards), and still blocks while
 * live.awaiting is set even after a later reply. A delegation is pending until its bot
 * sends the message that answers it, unless that bot's own rows show it never will (held
 * or handled without an answer, see delegations.ts). A pending box hand-off awaits
 * the owner once the bot stops (see blockingHandoff): no row marks it, so waiting would
 * only time out. A running subagent blocks only when it started during this turn (see
 * subagentsBlockTurn). The caller passes start times when it could read them.
 * Pure: the caller supplies every transcript row it has, the latest live status,
 * and, when known, when the bot's running subagents started.
 *
 * The server reports which run it settled (`live.lastTurnSettlement`, see
 * settlementOfTurn). Once a settlement of the turn's latest run is known, live status
 * no longer decides whether that run ended: a bot busy with a later run does not hold
 * the turn, and a quiet window is not needed. Open cards, delegations, the turn's
 * subagents, box hand-offs and the final reply still decide. Without a settlement of
 * the latest run, or when a subagent ran in the turn (its end starts the run that
 * answers, which no row shows yet), the rule is exactly as before.
 */
export function evaluateDoneRule(input: DoneRuleInput): DoneVerdict {
  return reportTurn(input).verdict;
}

/** The Done Rule's verdict with what the server's settlement of the turn added to it. */
export interface TurnReport {
  readonly verdict: DoneVerdict;
  /** The server settled the turn's latest run, whatever the outcome. */
  readonly settled: boolean;
  /**
   * The error or cancellation the server ended the turn's latest run with, while no reply
   * of that run answers it. Set only when the verdict is running, awaiting-final-reply:
   * the same stall a turnFailed frame fails, but the server said so itself.
   */
  readonly failure?: TurnSettlement;
}

/** {@link evaluateDoneRule} that also reports the settlement of the turn. */
export function reportTurn(input: DoneRuleInput): TurnReport {
  const { entries, sentMessageId, status, busyAtSend, delegations } = input;
  const turn = findTurn(entries, sentMessageId, busyAtSend, delegations);
  if (!turn) return { verdict: running("awaiting-echo"), settled: false };
  const settlement = subagentsRanInTurn(turn, input.subagentsSeen)
    ? undefined
    : settlementOfTurn(turn, sentMessageId, [
        ...(input.settlements ?? []),
        ...(status.lastTurnSettlement ? [status.lastTurnSettlement] : []),
      ]);
  const verdict = judgeTurn(turn, input, settlement !== undefined);
  const stalled =
    verdict.status === "running" && verdict.reason === "awaiting-final-reply";
  return {
    verdict,
    settled: settlement !== undefined,
    ...(stalled &&
      settlement !== undefined &&
      settlement.outcome !== "success" && { failure: settlement }),
  };
}

/** The Done Rule over a found turn; `ended` when the server settled its latest run. */
function judgeTurn(
  turn: Turn,
  { status, subagentStartedAtMs }: DoneRuleInput,
  ended: boolean,
): DoneVerdict {
  const live = ended
    ? { ...status, isRunning: false, isComposing: false, isRetrying: false }
    : status;
  const cards = blockingCards(turn, live);
  const handoff = blockingHandoff(status, turn);

  if (status.awaiting && cards.length > 0) {
    return {
      status: "awaiting-approval",
      reason: status.awaiting.reason,
      cards,
      ...(handoff && { handoff }),
    };
  }
  if (!ended) {
    if (status.awaiting && !handoff) return running("target-active");
    if (status.isRunning || status.isComposing || status.isRetrying)
      return running("target-active");
  }
  if (handoff) {
    const reason = describeBoxHandoff(handoff);
    return { status: "awaiting-approval", reason, cards, handoff };
  }
  if (
    status.hasRunningSubagents &&
    subagentsBlockTurn(turn, subagentStartedAtMs)
  )
    return running("subagents-active");
  const [card] = cards;
  if (turn.hasOpenDelegation) {
    // An open card of an idle bot wins over delegations that can only pair by agent: no
    // read of the delegate tells whether it will answer (a Cursor cloud agent has no
    // status, live 20 Oct), so waiting on it would hide a card the owner must answer.
    // A delegate that was read and is working, or inside its grace, keeps the job running.
    const cardWins =
      card !== undefined &&
      !isActive(live) &&
      turn.delegations.open.every(
        (d) => d.state.kind === "by-agent" || d.state.kind === "released",
      );
    if (!cardWins) return running("pending-delegation");
  }
  if (card)
    return { status: "awaiting-approval", reason: cardReason(card), cards };
  const final =
    turn.tail.filter(isFinalCandidate).at(-1) ??
    turn.tail.filter(isFinishedMedia).at(-1);
  if (!final || isStreaming(final)) return running("awaiting-final-reply");
  const replies = turn.rows.filter((e): e is ReplyEntry => e.kind === "reply");
  if (turn.sharedReason !== undefined) {
    const blobHash = final.kind === "blob" ? final.blobHash : undefined;
    const marker =
      final.kind === "blob"
        ? blobReplyMarker(final.blobHash)
        : final.reply.type === "text"
          ? undefined
          : mediaReplyMarker(final.reply);
    return {
      status: "ambiguous",
      reason: turn.sharedReason,
      replyText: sharedReplyText(turn.rows, marker),
      replies,
      ...(blobHash !== undefined && { blobHash }),
    };
  }
  if (final.kind === "blob") {
    const { blobHash } = final;
    return {
      status: "done",
      finalReply: blobReplyMarker(blobHash),
      replies,
      blobHash,
    };
  }
  if (final.reply.type !== "text") {
    return {
      status: "done",
      finalReply: mediaReplyMarker(final.reply),
      replies,
    };
  }
  const finalReply = roomReplyText(replies) ?? final.reply.content;
  return { status: "done", finalReply, replies };
}
