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

/** A message the bot sent another bot in `entries` that has no reply from it there yet. */
function hasOpenDelegation(entries: readonly TranscriptEntry[]): boolean {
  const open: AgentRef[] = [];
  for (const e of entries) {
    if (e.kind === "assistant-message" && e.toAgent) open.push(e.toAgent);
    const from = e.kind === "user-message" ? e.fromAgent : undefined;
    const at = from ? open.findIndex((to) => isSameAgent(to, from)) : -1;
    if (at >= 0) open.splice(at, 1);
  }
  return open.length > 0;
}

/**
 * A message sent now may share a run with earlier work (see turn-sharing.ts): a run or
 * its subagents are still working or awaiting the owner, a delegate's reply is still due
 * (it starts a new run), or the newest row is a message (ours, the owner's, or another
 * bot's) that no run has answered yet, an open card, or a reply still being written.
 */
function isBotBusy(status: LiveStatus, recent: EntriesPage): boolean {
  if (isActive(status) || status.awaiting) return true;
  if (hasOpenDelegation(recent.entries)) return true;
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

/** Reads the recent rows, then the live status, just before a send. */
export async function snapshotBeforeSend(
  server: ServerTransport,
  agentId: string,
  signal?: AbortSignal,
): Promise<SendSnapshot> {
  const recent = parseEntriesResponse(
    await server.call(
      "ListGrokBotTranscriptEntries",
      { agentId, sessionId: "", limit: BASELINE_ROWS },
      { signal },
    ),
  );
  const statuses = parseAgentStatusesResponse(
    await server.call(
      "ListGrokBotAgentStatuses",
      { agentIds: [agentId] },
      { signal },
    ),
  );
  return {
    baseline: transcriptCursor(agentId, recent),
    botBusy: isBotBusy(statuses.get(agentId) ?? IDLE_STATUS, recent),
  };
}
