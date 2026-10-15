import type { CommandName, CommandOutputs, JobOutcome } from "grokbot-core";

export const EXIT_CODE = {
  ok: 0,
  failure: 1,
  usage: 2,
  awaitingApproval: 3,
  /** The wait timed out; `grokbot wait <jobId>` resumes it. */
  pending: 4,
  interrupted: 130,
} as const;
export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

const OUTCOME_EXIT: { readonly [S in JobOutcome["status"]]: ExitCode } = {
  done: EXIT_CODE.ok,
  "awaiting-approval": EXIT_CODE.awaitingApproval,
  pending: EXIT_CODE.pending,
};

/** Commands that follow a job (ask, wait) exit by its outcome; the rest exit 0. */
export function exitCodeFor(output: CommandOutputs[CommandName]): ExitCode {
  return "outcome" in output
    ? OUTCOME_EXIT[output.outcome.status]
    : EXIT_CODE.ok;
}
