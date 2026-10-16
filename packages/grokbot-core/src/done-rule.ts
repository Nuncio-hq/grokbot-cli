import type { LiveStatus } from "./agent-status.js";
import {
  asJsonObject,
  type BlobEntry,
  type CardEntry,
  readString,
  type TranscriptEntry,
} from "./transcript.js";
import { findTurn } from "./turn-model.js";
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

export interface DoneRuleInput {
  readonly entries: readonly TranscriptEntry[];
  /** The messageId we sent; the server echoes it back as the user row's clientNonce. */
  readonly sentMessageId: string;
  readonly status: LiveStatus;
  /** Whether the bot was busy when each message we know of was sent; missing means busy. */
  readonly busyAtSend?: BusyAtSend;
}

const running = (reason: RunningReason): DoneVerdict => ({
  status: "running",
  reason,
});

export function blobReplyMarker(blobHash: string): string {
  return `[reply stored as blob ${blobHash}; run grokbot tail]`;
}

/** What a card asks the owner when live.awaiting gives no reason: a widget's prompt, else its type. */
function cardReason(card: CardEntry): string {
  const widget = asJsonObject(card.message.widget);
  return (widget && readString(widget, "prompt")) || card.cardType;
}

type TextReplyEntry = ReplyEntry & {
  readonly reply: Extract<ReplyEntry["reply"], { type: "text" }>;
};

function isFinalCandidate(e: TranscriptEntry): e is TextReplyEntry | BlobEntry {
  if (e.kind === "blob") return e.entryKind === "send-message";
  return e.kind === "reply" && e.reply.type === "text";
}

const isStreaming = (e: TranscriptEntry): boolean =>
  "isStreaming" in e && e.isStreaming === true;

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

/** Every reply of a shared turn: its text replies in order, a blob final reply as its marker. */
function sharedReplyText(
  turn: readonly TranscriptEntry[],
  blobHash: string | undefined,
): string {
  const texts = turn.flatMap((e) =>
    e.kind === "reply" && e.reply.type === "text" ? [e.reply.content] : [],
  );
  if (blobHash !== undefined) texts.push(blobReplyMarker(blobHash));
  return texts.join("\n\n");
}

/**
 * Decides whether the turn started by `sentMessageId` has finished.
 * The turn is the runs of our message and of any message one run may have answered with
 * it, plus the runs our delegates' replies and the owner's card answers start (see
 * findTurn); the final reply is the last text (or blob) reply of the latest run. A turn
 * that may be shared ends `ambiguous` with every reply, never `done` with one of them.
 * An open card of the turn awaits the owner once the bot stops, even when live.awaiting
 * is unset (question widgets leave it unset), but live.awaiting alone never makes the
 * turn await: it may belong to a later turn.
 * Pure: the caller supplies every transcript row it has and the latest live status.
 */
export function evaluateDoneRule({
  entries,
  sentMessageId,
  status,
  busyAtSend,
}: DoneRuleInput): DoneVerdict {
  const turn = findTurn(entries, sentMessageId, busyAtSend);
  if (!turn) return running("awaiting-echo");
  const cards = turn.openCards;

  if (status.awaiting) {
    if (cards.length === 0) return running("target-active");
    return {
      status: "awaiting-approval",
      reason: status.awaiting.reason,
      cards,
    };
  }
  if (status.isRunning || status.isComposing || status.isRetrying)
    return running("target-active");
  if (status.hasRunningSubagents) return running("subagents-active");
  if (turn.hasOpenDelegation) return running("pending-delegation");
  const [card] = cards;
  if (card)
    return { status: "awaiting-approval", reason: cardReason(card), cards };
  const final = turn.tail.filter(isFinalCandidate).at(-1);
  if (!final || isStreaming(final)) return running("awaiting-final-reply");
  const replies = turn.rows.filter((e): e is ReplyEntry => e.kind === "reply");
  if (turn.sharedReason !== undefined) {
    const blobHash = final.kind === "blob" ? final.blobHash : undefined;
    return {
      status: "ambiguous",
      reason: turn.sharedReason,
      replyText: sharedReplyText(turn.rows, blobHash),
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
  const finalReply = roomReplyText(replies) ?? final.reply.content;
  return { status: "done", finalReply, replies };
}
