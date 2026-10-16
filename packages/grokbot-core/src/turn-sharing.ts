import type { TranscriptEntry } from "./transcript.js";

/**
 * Whether the bot was busy when each message went out, keyed by message id (the echo's
 * clientNonce). `send` records it on the job before it sends.
 */
export type BusyAtSend = ReadonlyMap<string, boolean>;

export type UserMessageEntry = Extract<
  TranscriptEntry,
  { kind: "user-message" }
>;

export interface SharedMessages {
  /** Owner messages one run may have answered together, ours included, in seq order. */
  readonly echoes: readonly UserMessageEntry[];
  /** Index in the rows of the first of them; the turn starts after it. */
  readonly startAt: number;
  /** Ours reached a busy bot, and no earlier message it may share a run with is in view. */
  readonly sharesUnseenRun: boolean;
}

export const requestIdOf = (e: TranscriptEntry): string | undefined =>
  "requestId" in e ? e.requestId : undefined;

export const isOwnerMessage = (e: TranscriptEntry): e is UserMessageEntry =>
  e.kind === "user-message" && e.fromAgent === undefined;

/** Rows that show a run answering: a reply, a card, or a message to another bot. */
const isAnswer = (e: TranscriptEntry): boolean =>
  e.kind === "reply" || e.kind === "card" || e.kind === "assistant-message";

/**
 * Live 15 and 16 Oct (#169 to #182): a message that reaches a busy bot gets its own
 * requestId, but the run in progress posts nothing more and the new message's run answers
 * both, so neither job can tell its reply from the other's. Owner messages X then Y are
 * therefore linked unless the bot had answered X before Y arrived AND Y's job recorded the
 * bot idle at send. Any other message (typed in the app, or sent before the record existed)
 * counts as busy, so doubt never ends a job as done. Our own message shares an unseen run
 * only on an explicit busy record. Rows without a requestId show no runs; such a turn keeps
 * the plain cut at the owner's next message.
 */
export function sharedMessages(
  rows: readonly TranscriptEntry[],
  echoAt: number,
  echo: UserMessageEntry,
  busyAtSend: BusyAtSend,
): SharedMessages {
  const busy = (e: UserMessageEntry) =>
    e.clientNonce === undefined ? undefined : busyAtSend.get(e.clientNonce);
  const ownBusy = busy(echo) === true;
  if (requestIdOf(echo) === undefined)
    return { echoes: [echo], startAt: echoAt, sharesUnseenRun: ownBusy };

  /** The owner message at i; null (stops the chain) when it has no run, undefined for other rows. */
  const ownerAt = (i: number): UserMessageEntry | null | undefined => {
    const e = rows[i];
    if (!e || !isOwnerMessage(e)) return undefined;
    return requestIdOf(e) === undefined ? null : e;
  };
  /** True when the run of the message at x answered before `later` (at y) found the bot idle. */
  const apart = (x: number, y: number, runs: readonly UserMessageEntry[]) => {
    const ids = new Set(runs.map(requestIdOf));
    const later = rows[y] as UserMessageEntry;
    return (
      busy(later) === false &&
      rows.slice(x + 1, y).some((e) => isAnswer(e) && ids.has(requestIdOf(e)))
    );
  };

  const echoes: UserMessageEntry[] = [echo];
  let startAt = echoAt;
  for (let p = echoAt - 1; p >= 0; p--) {
    const earlier = ownerAt(p);
    if (earlier === undefined) continue;
    if (earlier === null || apart(p, startAt, [earlier])) break;
    echoes.unshift(earlier);
    startAt = p;
  }
  let lastAt = echoAt;
  for (let i = echoAt + 1; i < rows.length; i++) {
    const later = ownerAt(i);
    if (later === undefined) continue;
    if (later === null || apart(lastAt, i, echoes)) break;
    echoes.push(later);
    lastAt = i;
  }
  return { echoes, startAt, sharesUnseenRun: ownBusy && startAt === echoAt };
}

/** Why the turn's replies may not answer our message alone; undefined when they do. */
export function sharedReason(
  { echoes, sharesUnseenRun }: SharedMessages,
  echo: UserMessageEntry,
): string | undefined {
  const others = echoes.filter((e) => e !== echo).map((e) => `#${e.seq}`);
  const named =
    others.length === 0
      ? undefined
      : `${others.length === 1 ? "message" : "messages"} ${others.join(", ")}`;
  const unseen = sharesUnseenRun
    ? "the message it was busy with when this one arrived"
    : undefined;
  const with_ = [unseen, named].filter(Boolean).join(" and ");
  return with_ === ""
    ? undefined
    : `the bot may have answered this message in one run together with ${with_}`;
}
