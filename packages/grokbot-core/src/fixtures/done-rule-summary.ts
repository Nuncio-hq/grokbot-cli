import type { LiveStatus } from "../agent-status.js";
import { evaluateDoneRule } from "../done-rule.js";
import { parseTranscriptEntries } from "../transcript.js";
import type { WireEntry } from "./wire-entries.js";

export function verdict(
  rows: readonly WireEntry[],
  status: LiveStatus,
  sentMessageId = "m-1",
) {
  return evaluateDoneRule({
    entries: parseTranscriptEntries(rows),
    sentMessageId,
    status,
  });
}

/** One-string verdict: `running:<reason>`, `awaiting-approval:<seqs>`, or `done:<finalReply>`. */
export function summary(
  rows: readonly WireEntry[],
  status: LiveStatus,
  sentMessageId = "m-1",
): string {
  const v = verdict(rows, status, sentMessageId);
  if (v.status === "running") return `running:${v.reason}`;
  if (v.status === "awaiting-approval") {
    return `awaiting-approval:${v.cards.map((c) => c.seq).join(",")}`;
  }
  return `done:${v.finalReply}`;
}
