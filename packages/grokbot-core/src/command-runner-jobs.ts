import type { Agent } from "./agents.js";
import type { JobOutcome, RunOptions } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import {
  advanceQueue,
  type JobContext,
  type JobOrigin,
  newQueuedJob,
  untilSent,
} from "./job-queue.js";
import {
  isFinalState,
  type JobRecord,
  type JobState,
  type JobStore,
} from "./job-store.js";
import type { BusyAtSend } from "./turn-sharing.js";
import { waitForDone } from "./wait-for-done.js";

export type { JobContext } from "./job-queue.js";

/**
 * Saves `text` as a queued job, then sends the bot's queue if the bot is free, so a bot
 * only ever has one of our messages in hand (job-queue.ts). The job comes back pending
 * when it went out now, queued when it waits behind earlier work. A refused message
 * leaves no job, and so does an error before the send. Any other send error keeps the sending record: the message may have
 * landed, and `wait` finds its echo. `replyToId` sends it as a reply to that transcript
 * entry, also when it waits in the queue first. `origin` is the job id the text's header
 * already names, with the sender's session.
 */
export async function dispatchMessage(
  ctx: JobContext,
  agent: Agent,
  text: string,
  signal?: AbortSignal,
  replyToId?: string,
  origin?: JobOrigin,
): Promise<JobRecord> {
  const queued = newQueuedJob(agent, text, replyToId, origin);
  await ctx.jobs.save(queued);
  try {
    await advanceQueue(ctx, agent.agentId, queued.jobId, signal);
  } catch (error) {
    // Never sent (refused, or still queued): drop it rather than send it later unseen.
    const state = (await ctx.jobs.load(queued.jobId))?.state;
    if (
      state?.status === "queued" ||
      (state?.status === "failed" && state.notSent)
    )
      await ctx.jobs.remove(queued.jobId);
    throw error;
  }
  const saved = await ctx.jobs.load(queued.jobId);
  if (!saved)
    throw new GrokBotError("not-found", `job ${queued.jobId} left the store`);
  return saved;
}

function stateOf(outcome: JobOutcome): JobState {
  switch (outcome.status) {
    case "done":
      return { status: "done", finalReply: outcome.finalReply };
    case "ambiguous": {
      const { reason, replyText } = outcome;
      return { status: "ambiguous", reason, replyText };
    }
    case "awaiting-approval":
      return { status: "awaiting-approval", reason: outcome.reason };
    case "pending":
      return { status: "pending" };
  }
}

/** The saved outcome of a final job, answered without the network. */
function savedOutcome(state: JobState): JobOutcome | undefined {
  if (state.status === "done")
    return { status: "done", finalReply: state.finalReply, replies: [] };
  if (state.status === "ambiguous") {
    const { reason, replyText } = state;
    return { status: "ambiguous", reason, replyText, replies: [] };
  }
  return undefined;
}

/**
 * What the saved jobs on this agent recorded about the bot at send, ours included.
 * An unreadable store gives no records, which only makes attribution stricter.
 */
export async function busyRecords(jobs: JobStore, job: JobRecord) {
  const saved = await jobs.list().catch(() => []);
  const busy = new Map<string, boolean>();
  for (const j of [...saved, job]) {
    if (j.agentId === job.agentId && j.botBusyAtSend !== undefined)
      busy.set(j.sentMessageId, j.botBusyAtSend);
  }
  return busy satisfies BusyAtSend;
}

/**
 * Hands the bot to the next queued message once a turn has ended. Best effort: a failure
 * here belongs to that message, and its own `wait` (or the next send) advances the queue.
 * Only the caller's abort is rethrown.
 */
async function handOff(ctx: JobContext, agentId: string, signal?: AbortSignal) {
  await advanceQueue(ctx, agentId, undefined, signal).catch(
    (error: unknown) => {
      if (signal?.aborted) throw error;
    },
  );
}

/**
 * Sends a queued job when the bot is free, then waits for its turn and saves where it
 * stands, all within one timeout. A job saved as done or ambiguous returns its saved
 * result without touching the network. A refused queued message throws its refusal. A
 * timeout becomes a pending outcome (a queued job stays queued); a caller abort leaves
 * the saved state alone so `wait` can resume. A turn that ends sends the next message.
 */
export async function followJob(
  ctx: JobContext,
  job: JobRecord,
  timeoutSeconds: number,
  { signal, onEvent }: RunOptions,
): Promise<JobOutcome> {
  const { server, jobs } = ctx;
  const saved = isFinalState(job.state) ? savedOutcome(job.state) : undefined;
  if (saved) return saved;
  if (job.state.status === "failed" && job.state.notSent)
    throw new GrokBotError("protocol", job.state.error);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const sent =
    job.state.status === "queued"
      ? await untilSent(ctx, job, deadline, signal, onEvent)
      : job;
  if (sent.state.status === "queued") {
    const name = sent.agentName ?? "The bot";
    return {
      status: "pending",
      reason: `${name} is busy with earlier work, so the message is queued and not sent yet`,
      queued: true,
    };
  }
  let outcome: JobOutcome;
  try {
    outcome = await waitForDone({
      server,
      job: { ...sent, busyAtSend: await busyRecords(jobs, sent) },
      timeoutMs:
        sent === job
          ? timeoutSeconds * 1000
          : Math.max(0, deadline - Date.now()),
      signal,
      onEvent,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!(error instanceof GrokBotError && error.code === "timeout")) {
      const message = error instanceof Error ? error.message : String(error);
      await jobs.save({ ...sent, state: { status: "failed", error: message } });
      throw error;
    }
    outcome = { status: "pending", reason: error.message };
  }
  await jobs.save({ ...sent, state: stateOf(outcome) });
  if (outcome.status === "done" || outcome.status === "ambiguous")
    await handOff(ctx, sent.agentId, signal);
  return outcome;
}
