import type { JobOutcome } from "./command-outputs-dispatch.js";

/** How a job's saved record is named in a message header and by `grokbot inbox wait --job`. */
export const JOB_HANDLE_LENGTH = 8;

/**
 * The next step after a send whose answer is not in yet, worded for any agent runtime:
 * `grokbot wait <job>` for the answer, `grokbot inbox wait --job <job8>` for what the bot
 * leaves later, either one in the background when the runtime can run a command there.
 */
export function nextStep(jobId: string): string {
  return `Wait for the answer with \`grokbot wait ${jobId}\`, and for anything the bot leaves later with \`grokbot inbox wait --job ${jobId.slice(0, JOB_HANDLE_LENGTH)}\`. If your runtime can run a command in the background and tell you when it ends, run them that way; otherwise run them before you finish. Do not poll in a sleep loop.`;
}

/** `nextStep` for a job that has not settled; nothing when the answer is in. */
export function nextStepUnless(
  jobId: string,
  outcome: JobOutcome,
): { readonly next?: string } {
  return outcome.status === "done" || outcome.status === "ambiguous"
    ? {}
    : { next: nextStep(jobId) };
}
