import { SETUP_CHECK_PROJECT } from "./bot-setup-prompt.js";
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

/**
 * What `grokbot setup-bots` leaves the agent to do, for any agent runtime: show the owner
 * the bot's project list and send their corrections, wait for the "Setup check" item the
 * bot posts for this session and job, and close it. A reply that is not in yet is waited
 * for first.
 */
export function setupNextStep(jobId: string, outcome: JobOutcome): string {
  const settled = outcome.status === "done" || outcome.status === "ambiguous";
  const steps = `Show the owner the project list from the reply and send their corrections with \`grokbot reply ${jobId} "<corrections>"\`. Wait for the "${SETUP_CHECK_PROJECT}" item the bot posts with \`grokbot inbox wait --job ${jobId.slice(0, JOB_HANDLE_LENGTH)}\` (in the background if your runtime can run a command there and tell you when it ends, otherwise before you finish; never in a sleep loop), and close it with \`grokbot inbox-done <id> --outcome done\`.`;
  return settled
    ? steps
    : `The reply is not in yet: wait for it with \`grokbot wait ${jobId}\` first. ${steps}`;
}
