import type { LiveStatus } from "./agent-status.js";
import {
  asJsonObject,
  type BlobEntry,
  type CardEntry,
  readString,
  type TranscriptEntry,
} from "./transcript.js";
import { findTurn } from "./turn-model.js";

export type { CardEntry } from "./transcript.js";
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
    };

export interface DoneRuleInput {
  readonly entries: readonly TranscriptEntry[];
  /** The messageId we sent; the server echoes it back as the user row's clientNonce. */
  readonly sentMessageId: string;
  readonly status: LiveStatus;
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

/**
 * Decides whether the turn started by `sentMessageId` has finished.
 * The turn is the echo's run plus the runs our delegates' replies and the owner's card
 * answers start (see findTurn); the final reply is the last text (or blob) reply of the
 * latest run. An open card of the turn awaits the owner once the bot stops, even when
 * live.awaiting is unset (question widgets leave it unset), but live.awaiting alone never
 * makes the turn await: it may belong to a later turn.
 * Pure: the caller supplies every transcript row it has and the latest live status.
 */
export function evaluateDoneRule({
  entries,
  sentMessageId,
  status,
}: DoneRuleInput): DoneVerdict {
  const turn = findTurn(entries, sentMessageId);
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
