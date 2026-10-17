import type { LiveStatus } from "../agent-status.js";
import { evaluateDoneRule } from "../done-rule.js";
import { parseTranscriptEntries } from "../transcript.js";
import type { WireEntry } from "./wire-entries.js";

export function verdict(
  rows: readonly WireEntry[],
  status: LiveStatus,
  sentMessageId = "m-1",
  busyAtSend?: ReadonlyMap<string, boolean>,
  subagentStartedAtMs?: readonly number[],
) {
  return evaluateDoneRule({
    entries: parseTranscriptEntries(rows),
    sentMessageId,
    status,
    ...(busyAtSend && { busyAtSend }),
    ...(subagentStartedAtMs !== undefined && { subagentStartedAtMs }),
  });
}

/**
 * One-string verdict: `running:<reason>`, `awaiting-approval:<seqs>`, `done:<finalReply>`,
 * or `ambiguous:<replyText>`.
 */
export function summary(
  rows: readonly WireEntry[],
  status: LiveStatus,
  sentMessageId = "m-1",
  busyAtSend?: ReadonlyMap<string, boolean>,
  subagentStartedAtMs?: readonly number[],
): string {
  const v = verdict(
    rows,
    status,
    sentMessageId,
    busyAtSend,
    subagentStartedAtMs,
  );
  if (v.status === "running") return `running:${v.reason}`;
  if (v.status === "awaiting-approval") {
    return `awaiting-approval:${v.cards.map((c) => c.seq).join(",")}`;
  }
  if (v.status === "ambiguous") return `ambiguous:${v.replyText}`;
  return `done:${v.finalReply}`;
}
