import type { LiveStatus } from "./agent-status.js";
import type { ServerTransport } from "./contracts.js";
import { type DelegationTarget, targetIdle } from "./delegations.js";
import { parseEntriesResponse, type TranscriptEntry } from "./transcript.js";
import { newestVersions } from "./turn-model.js";
import { isFatal } from "./wait-reconnect.js";

/** Rows of a delegate's transcript read to tell what became of a delegation: one bounded page. */
const DELEGATE_ROWS = 50;

/**
 * From when the rows hold every row of the transcript: undefined for a page that is not
 * full (it reaches the first row), else the oldest time in it (infinite when none has one).
 */
function windowStart(
  rows: readonly TranscriptEntry[],
  pageSize: number,
): number | undefined {
  if (pageSize < DELEGATE_ROWS) return undefined;
  const times = rows.flatMap((e) =>
    "timestampMs" in e && e.timestampMs !== undefined ? [e.timestampMs] : [],
  );
  return times.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...times);
}

/**
 * Reads the recent rows of the delegates in `ids`, after `statuses` were read at
 * `readAtMs`. Rows are read for a delegate that is idle (an answer or a hold shows in
 * them) and for those in `always` (several delegations went to it, and only its rows tell
 * which one an answer closes). A working delegate is otherwise left unread: its
 * delegations are pending whatever its rows say. A delegate with no status is left out,
 * and one whose read fails keeps its status without rows.
 */
export async function readDelegationTargets(
  server: ServerTransport,
  ids: readonly string[],
  statuses: ReadonlyMap<string, LiveStatus>,
  readAtMs: number,
  signal?: AbortSignal,
  always: readonly string[] = [],
): Promise<Map<string, DelegationTarget>> {
  const targets = new Map<string, DelegationTarget>();
  await Promise.all(
    ids.map(async (agentId) => {
      const status = statuses.get(agentId);
      if (status === undefined) return;
      const unread = {
        status,
        rows: undefined,
        windowStartMs: undefined,
        readAtMs,
      };
      if (!targetIdle(status) && !always.includes(agentId)) {
        targets.set(agentId, unread);
        return;
      }
      try {
        const page = parseEntriesResponse(
          await server.call(
            "ListGrokBotTranscriptEntries",
            { agentId, sessionId: "", limit: DELEGATE_ROWS },
            { signal },
          ),
        );
        const rows = newestVersions(page.entries);
        const windowStartMs = windowStart(rows, page.entries.length);
        targets.set(agentId, { status, rows, windowStartMs, readAtMs });
      } catch (error) {
        if (signal?.aborted || isFatal(error)) throw error;
        targets.set(agentId, unread);
      }
    }),
  );
  return targets;
}
