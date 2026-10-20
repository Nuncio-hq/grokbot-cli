import {
  IDLE_STATUS,
  isActive,
  type LiveStatus,
  parseAgentStatusesResponse,
} from "./agent-status.js";
import type { ServerTransport } from "./contracts.js";
import { readDelegationTargets } from "./delegation-reads.js";
import {
  DELEGATION_GRACE_MS,
  type OpenDelegation,
  scanDelegations,
} from "./delegations.js";
import {
  type EntriesPage,
  parseEntriesResponse,
  type TranscriptEntry,
} from "./transcript.js";
import {
  type TranscriptCursor,
  transcriptCursor,
} from "./transcript-stream.js";

/** Enough recent rows to find the highest updatedSeq before our message lands, and open delegations. */
const BASELINE_ROWS = 20;

/** A reply sent this recently may still be on its way to the bot. */
const REPLY_IN_FLIGHT_MS = 120_000;

/**
 * Whether an open delegation can still bring a reply (which starts a new run). One the
 * delegate's own rows show it will never answer (held, or handled without an answer; see
 * delegations.ts) cannot. One they show is still being worked on can. Otherwise, as
 * before: the bot it went to is still working, its status is unknown, or it was sent
 * moments ago. Live 16 Oct: a delegate that answered while idle never had its reply
 * delivered, so an idle delegate's old message is not waited on forever.
 */
function replyMayCome(
  { to, atMs, state }: OpenDelegation,
  statuses: ReadonlyMap<string, LiveStatus>,
): boolean {
  if (state.kind === "released") return false;
  if (state.kind !== "by-agent") return true;
  const status = to.id === undefined ? undefined : statuses.get(to.id);
  if (status === undefined || isActive(status) || status.awaiting) return true;
  return atMs === undefined || Date.now() - atMs < REPLY_IN_FLIGHT_MS;
}

/**
 * Another bot's message that the bot already handled without answering: it carries the
 * request id of the run that took it, that run had time to start, and the bot is idle now.
 * Live 19 Oct: a bot woken by "no reply needed" ran and posted nothing, so the message
 * stayed its newest row and kept every later message queued.
 */
function handledSilently(entry: TranscriptEntry): boolean {
  return (
    entry.kind === "user-message" &&
    entry.fromAgent !== undefined &&
    entry.requestId !== undefined &&
    entry.timestampMs !== undefined &&
    Date.now() - entry.timestampMs >= DELEGATION_GRACE_MS
  );
}

/**
 * A message sent now may share a run with earlier work (see turn-sharing.ts): a run or
 * its subagents are still working or awaiting the owner (a card or a box hand-off), a delegate's reply is still due
 * (it starts a new run), a message we just sent has no echo in view yet, or the newest
 * row is a message (ours, the owner's, or another bot's) that no run has answered yet,
 * an open card, or a reply still being written. Another bot's message that an idle bot
 * handled without answering does not count.
 */
function isBotBusy(
  agentId: string,
  statuses: ReadonlyMap<string, LiveStatus>,
  recent: EntriesPage,
  inFlight: readonly string[],
  delegations: readonly OpenDelegation[],
): boolean {
  const status = statuses.get(agentId) ?? IDLE_STATUS;
  if (isActive(status) || status.awaiting || status.boxHandoff) return true;
  const echoed = new Set(
    recent.entries.flatMap((e) =>
      e.kind === "user-message" && e.clientNonce ? [e.clientNonce] : [],
    ),
  );
  if (inFlight.some((id) => !echoed.has(id))) return true;
  if (delegations.some((d) => replyMayCome(d, statuses))) return true;
  const newest = recent.entries.at(-1);
  if (newest === undefined) return false;
  if (newest.kind === "user-message") return !handledSilently(newest);
  if (newest.kind === "card" && newest.open) return true;
  return "isStreaming" in newest && newest.isStreaming === true;
}

export interface SendSnapshot {
  /** Where the wait starts reading: after every row that existed before the send. */
  readonly baseline: TranscriptCursor;
  readonly botBusy: boolean;
}

/**
 * Reads the recent rows, then the live status, just before a send. `inFlight` holds the
 * message ids we sent moments ago, whose echo may not have landed yet. When the bot has an
 * open delegation to another bot, that bot's status joins the status read and, if it is
 * idle (or several delegations went to it), one page of its recent rows is read, so
 * delegations it will never answer do not keep our bot busy.
 */
export async function snapshotBeforeSend(
  server: ServerTransport,
  agentId: string,
  inFlight: readonly string[],
  signal?: AbortSignal,
): Promise<SendSnapshot> {
  const recent = parseEntriesResponse(
    await server.call(
      "ListGrokBotTranscriptEntries",
      { agentId, sessionId: "", limit: BASELINE_ROWS },
      { signal },
    ),
  );
  const asked = scanDelegations(recent.entries);
  const delegates = asked.open.flatMap((d) =>
    d.to.id === undefined ? [] : [d.to.id],
  );
  const agentIds = [...new Set([agentId, ...delegates])];
  const readAtMs = Date.now();
  const statuses = parseAgentStatusesResponse(
    await server.call("ListGrokBotAgentStatuses", { agentIds }, { signal }),
  );
  const targets = await readDelegationTargets(
    server,
    asked.targets,
    statuses,
    readAtMs,
    signal,
    asked.contested,
  );
  const { open } = scanDelegations(recent.entries, {
    selfId: agentId,
    targets,
  });
  return {
    baseline: transcriptCursor(agentId, recent),
    botBusy: isBotBusy(agentId, statuses, recent, inFlight, open),
  };
}
