import type { JsonObject } from "../contracts.js";
import type { WireEntry } from "./wire-entries.js";

/**
 * A bot whose committed rows and live status move on their own clock, so a scripted
 * stream can show a status ahead of the rows the unary calls return.
 * Commit rows in seq order.
 */
export function fakeBot(agentId: string, committed: readonly WireEntry[] = []) {
  const rows = [...committed];
  let live: JsonObject = { isRunning: true };
  return {
    commit(...entries: WireEntry[]) {
      rows.push(...entries);
    },
    setLive(fields: JsonObject) {
      live = fields;
    },
    calls: {
      ListGrokBotTranscriptEntries: (body: JsonObject) => {
        const before =
          typeof body.beforeSeq === "string"
            ? Number(body.beforeSeq)
            : Number.POSITIVE_INFINITY;
        const limit = typeof body.limit === "number" ? body.limit : 50;
        const older = rows.filter((r) => Number(r.seq) < before);
        return { entries: older.slice(-limit) };
      },
      ListGrokBotAgentStatuses: () => ({ statuses: [{ agentId, live }] }),
    },
  };
}
