import { type AgentRef, isSameAgent } from "./agent-ref.js";
import {
  IDLE_STATUS,
  isActive,
  type LiveStatus,
  parseAgentStatusesResponse,
} from "./agent-status.js";
import type { ServerTransport } from "./contracts.js";
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

interface OpenDelegation {
  readonly to: AgentRef;
  readonly atMs: number | undefined;
}

/** Messages the bot sent other bots in `entries` that have no reply from them there yet. */
function openDelegations(
  entries: readonly TranscriptEntry[],
): OpenDelegation[] {
  const open: OpenDelegation[] = [];
  for (const e of entries) {
    if (e.kind === "assistant-message" && e.toAgent)
      open.push({ to: e.toAgent, atMs: e.timestampMs });
    const from = e.kind === "user-message" ? e.fromAgent : undefined;
    const at = from ? open.findIndex((d) => isSameAgent(d.to, from)) : -1;
    if (at >= 0) open.splice(at, 1);
  }
  return open;
}

/**
 * Whether an open delegation can still bring a reply (which starts a new run): the bot it
 * went to is still working, its status is unknown, or it was sent moments ago. Live 16 Oct:
 * a delegate that answered while idle never had its reply delivered, so an idle delegate's
 * old message is not waited on forever.
 */
function replyMayCome(
  { to, atMs }: OpenDelegation,
  statuses: ReadonlyMap<string, LiveStatus>,
): boolean {
  const status = to.id === undefined ? undefined : statuses.get(to.id);
  if (status === undefined || isActive(status) || status.awaiting) return true;
  return atMs === undefined || Date.now() - atMs < REPLY_IN_FLIGHT_MS;
}

/**
 * A message sent now may share a run with earlier work (see turn-sharing.ts): a run or
 * its subagents are still working or awaiting the owner, a delegate's reply is still due
 * (it starts a new run), a message we just sent has no echo in view yet, or the newest
 * row is a message (ours, the owner's, or another bot's) that no run has answered yet,
 * an open card, or a reply still being written.
 */
function isBotBusy(
  agentId: string,
  statuses: ReadonlyMap<string, LiveStatus>,
  recent: EntriesPage,
  inFlight: readonly string[],
): boolean {
  const status = statuses.get(agentId) ?? IDLE_STATUS;
  if (isActive(status) || status.awaiting) return true;
  const echoed = new Set(
    recent.entries.flatMap((e) =>
      e.kind === "user-message" && e.clientNonce ? [e.clientNonce] : [],
    ),
  );
  if (inFlight.some((id) => !echoed.has(id))) return true;
  if (openDelegations(recent.entries).some((d) => replyMayCome(d, statuses)))
    return true;
  const newest = recent.entries.at(-1);
  if (newest === undefined) return false;
  if (newest.kind === "user-message") return true;
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
 * message ids we sent moments ago, whose echo may not have landed yet.
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
  const delegates = openDelegations(recent.entries).flatMap((d) =>
    d.to.id === undefined ? [] : [d.to.id],
  );
  const agentIds = [...new Set([agentId, ...delegates])];
  const statuses = parseAgentStatusesResponse(
    await server.call("ListGrokBotAgentStatuses", { agentIds }, { signal }),
  );
  return {
    baseline: transcriptCursor(agentId, recent),
    botBusy: isBotBusy(agentId, statuses, recent, inFlight),
  };
}
