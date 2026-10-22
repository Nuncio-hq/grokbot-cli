import { GrokBotError } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/** One hit of the Box Gateway's `searchConversation`: a message with the words that matched. */
export interface ConversationMatch {
  /** What `grokbot reply --to` takes. */
  readonly entryId: string;
  /** The row's place in the transcript; `--before` pages by it. */
  readonly seq: number;
  /** "assistant" for the bot, "user" for the owner. */
  readonly role: string;
  readonly timestampMs: number | undefined;
  /** The matching words with a little context, as the gateway cut it. */
  readonly snippet: string;
}

/** One page of a conversation search, newest match first. */
export interface ConversationSearchPage {
  readonly matches: readonly ConversationMatch[];
  /** The gateway's own flag. It does not say whether older matches remain: it was true on a full page with older matches behind it. */
  readonly isComplete: boolean;
  /** Pass as `beforeSeq` for the next, older page; absent when this page looks like the last. */
  readonly nextBeforeSeq?: number;
}

function parseMatch(raw: unknown): ConversationMatch {
  const row = asJsonObject(raw);
  const entryId = row === undefined ? undefined : readString(row, "entryId");
  const seq = row?.seq;
  if (
    row === undefined ||
    entryId === undefined ||
    typeof seq !== "number" ||
    !Number.isInteger(seq)
  ) {
    throw new GrokBotError(
      "protocol",
      "searchConversation: a match has no entryId and seq.",
    );
  }
  return {
    entryId,
    seq,
    role: readString(row, "role") ?? "",
    timestampMs:
      typeof row.timestampMs === "number" ? row.timestampMs : undefined,
    snippet: readString(row, "snippet") ?? "",
  };
}

/**
 * Parses a `searchConversation` reply: `{ matches: [{ entryId, seq, role, timestampMs,
 * snippet }], isComplete }`, newest first, `beforeSeq` exclusive. A page as long as the
 * `limit` asked for, or one the gateway says is not complete, may have older matches behind
 * it, so it carries `nextBeforeSeq`, the lowest `seq` on the page.
 */
export function parseConversationSearch(
  raw: unknown,
  limit: number,
): ConversationSearchPage {
  const body = asJsonObject(raw);
  const rows = body?.matches;
  if (!Array.isArray(rows)) {
    throw new GrokBotError(
      "protocol",
      "searchConversation: the reply has no matches list.",
    );
  }
  const matches = rows.map(parseMatch);
  const isComplete = body?.isComplete !== false;
  const mayHaveMore = matches.length >= limit || !isComplete;
  return {
    matches,
    isComplete,
    ...(matches.length > 0 &&
      mayHaveMore && {
        nextBeforeSeq: Math.min(...matches.map((m) => m.seq)),
      }),
  };
}
