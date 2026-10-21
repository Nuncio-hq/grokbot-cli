import type { CommandName, CommandOutputs, JobOutcome } from "grokbot-core";

export const EXIT_CODE = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** `grokbot inbox check` found undelivered items: a hook blocks the stop and shows them. Same value as `usage`, the convention such hooks read. */
  inboxItems: 2,
  awaitingApproval: 3,
  /** The wait timed out; `grokbot wait <jobId>` resumes it. */
  pending: 4,
  /** The turn ended, but one run may have answered this message with another; stdout has every reply. */
  ambiguous: 5,
  interrupted: 130,
} as const;
export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

type CloudAgentOutcome = NonNullable<CommandOutputs["cloud-agent"]["outcome"]>;

const OUTCOME_EXIT: {
  readonly [S in JobOutcome["status"] | CloudAgentOutcome["status"]]: ExitCode;
} = {
  done: EXIT_CODE.ok,
  "awaiting-approval": EXIT_CODE.awaitingApproval,
  // A cloud agent that waits on the user is the same state to a caller: exit 3.
  "needs-you": EXIT_CODE.awaitingApproval,
  pending: EXIT_CODE.pending,
  ambiguous: EXIT_CODE.ambiguous,
};

/** Commands that follow a job (ask, wait) or an agent (cloud-agent --wait) exit by their outcome; the rest exit 0. */
export function exitCodeFor(
  name: CommandName,
  output: CommandOutputs[CommandName],
): ExitCode {
  // `inbox check` blocks a stop when it found items.
  if (name === "inbox-check" && "items" in output && output.items.length > 0)
    return EXIT_CODE.inboxItems;
  // `inbox wait` ran out of time: still waiting, like a pending job.
  if ("timedOut" in output && output.timedOut) return EXIT_CODE.pending;
  return "outcome" in output && output.outcome !== undefined
    ? OUTCOME_EXIT[output.outcome.status]
    : EXIT_CODE.ok;
}
