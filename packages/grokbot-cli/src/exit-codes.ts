import type { CommandName, CommandOutputs, JobOutcome } from "grokbot-core";

export const EXIT_CODE = {
  ok: 0,
  failure: 1,
  usage: 2,
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
export function exitCodeFor(output: CommandOutputs[CommandName]): ExitCode {
  return "outcome" in output && output.outcome !== undefined
    ? OUTCOME_EXIT[output.outcome.status]
    : EXIT_CODE.ok;
}
