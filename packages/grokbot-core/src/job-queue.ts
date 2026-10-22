import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withAgentLock } from "./agent-lock.js";
import type { Agent } from "./agents.js";
import type { QueuedEvent } from "./command-runner-contract.js";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { type SendSnapshot, snapshotBeforeSend } from "./job-send-snapshot.js";
import type { JobRecord, JobStore } from "./job-store.js";
import { JOB_HANDLE_LENGTH } from "./next-step.js";
import { asJsonObject, readString } from "./transcript.js";

export interface JobContext {
  readonly server: ServerTransport;
  readonly jobs: JobStore;
}

/** A sent message's echo lands within seconds; until then the transcript cannot show it. */
const ECHO_WINDOW_MS = 60_000;
/** How often a waiter on a queued message checks whether the bot is free. */
const POLL_MS = 2_000;

/** Throws GrokBotError("protocol") unless SendGrokBotUserMessage dispatched the message. */
function assertDispatched(raw: unknown): void {
  const response: JsonObject = asJsonObject(raw) ?? {};
  const delivery = readString(response, "delivery");
  const refused = delivery?.endsWith("REFUSED") === true;
  if (response.dispatched === true && !refused) return;
  const refusal = asJsonObject(response.refusal) ?? {};
  const message = readString(refusal, "message");
  const code = readString(refusal, "failureCode");
  const detail =
    message !== undefined
      ? `refused the message: ${message}${code ? ` (${code})` : ""}`
      : refused
        ? `refused the message: delivery ${delivery}`
        : `did not dispatch the message (delivery ${delivery ?? "unset"})`;
  throw new GrokBotError("protocol", `SendGrokBotUserMessage ${detail}`);
}

/** The id a job will have and the session that sends it, known before its text is written. */
export interface JobOrigin {
  readonly jobId: string;
  /** The sender's session address, when grokbot could tell which session it is. */
  readonly session?: string;
}

/** What a message header names the job by: the first 8 characters of its id. */
export const jobHandle = (jobId: string): string =>
  jobId.slice(0, JOB_HANDLE_LENGTH);

/**
 * A job for `text` that waits its turn; the snapshot fields are filled when it is sent.
 * `replyToId` makes it a reply to that transcript entry, and goes out with the message.
 * `origin` fixes the job id (the message header already names it) and records the session.
 */
export function newQueuedJob(
  agent: Agent,
  text: string,
  replyToId?: string,
  origin?: JobOrigin,
): JobRecord {
  const now = Date.now();
  return {
    jobId: origin?.jobId ?? randomUUID(),
    agentId: agent.agentId,
    agentName: agent.name,
    text,
    queuedAtMs: now,
    ...(replyToId !== undefined && { replyToId }),
    ...(origin?.session !== undefined && { session: origin.session }),
    sentMessageId: randomUUID(),
    sentAtMs: now,
    baselineUpdatedSeq: "0",
    generation: "0",
    state: { status: "queued" },
  };
}

/** The bot's queued jobs, oldest first. */
function queueOf(saved: readonly JobRecord[], agentId: string): JobRecord[] {
  const at = (j: JobRecord) => j.queuedAtMs ?? j.sentAtMs;
  return saved
    .filter((j) => j.agentId === agentId && j.state.status === "queued")
    .sort((a, b) => at(a) - at(b) || a.jobId.localeCompare(b.jobId));
}

/** Messages we sent the bot moments ago whose echo may not be in the transcript yet. */
function inFlightIds(saved: readonly JobRecord[], agentId: string): string[] {
  const now = Date.now();
  return saved
    .filter(
      (j) =>
        j.agentId === agentId &&
        (j.state.status === "sending" || j.state.status === "pending") &&
        now - j.sentAtMs < ECHO_WINDOW_MS,
    )
    .map((j) => j.sentMessageId);
}

/**
 * Sends a queued job with the snapshot taken just now, while the bot is free. A refusal
 * is saved as failed and not sent, with the text, and is returned, not thrown. Any
 * other error leaves the sending record: the message may have landed.
 */
async function sendQueued(
  { server, jobs }: JobContext,
  head: JobRecord,
  { baseline, botBusy }: SendSnapshot,
  signal?: AbortSignal,
): Promise<GrokBotError | undefined> {
  const { text, ...rest } = head;
  const sentAtMs = Date.now();
  const sending: JobRecord = {
    ...rest,
    sentAtMs,
    baselineUpdatedSeq: baseline.afterUpdatedSeq,
    generation: baseline.generation,
    botBusyAtSend: botBusy,
    state: { status: "sending" },
  };
  if (text === undefined) {
    const error = new GrokBotError("protocol", "queued job has no message");
    const state = {
      status: "failed",
      error: error.message,
      notSent: true,
    } as const;
    await jobs.save({ ...head, state });
    return error;
  }
  await jobs.save(sending);
  const response = await server.call(
    "SendGrokBotUserMessage",
    {
      agentId: head.agentId,
      messageId: head.sentMessageId,
      text,
      ...(head.replyToId !== undefined && { replyToId: head.replyToId }),
      sentAtMs: String(sentAtMs),
      sessionId: "",
    },
    { signal },
  );
  try {
    assertDispatched(response);
  } catch (refused) {
    if (!(refused instanceof GrokBotError)) throw refused;
    const state = {
      status: "failed",
      error: refused.message,
      notSent: true,
    } as const;
    await jobs.save({ ...sending, text, state });
    return refused;
  }
  await jobs.save({ ...sending, state: { status: "pending" } });
  return undefined;
}

/**
 * Under the bot's lock, sends its queued messages oldest first while it is free: one,
 * since the bot is busy after it, or the next one when the server refuses a message.
 * Errors on job `own` are thrown; another job's failure stays on its record for its
 * own waiter, and stops the queue here.
 */
export function advanceQueue(
  ctx: JobContext,
  agentId: string,
  own?: string,
  signal?: AbortSignal,
): Promise<void> {
  return withAgentLock(
    ctx.jobs.dir,
    agentId,
    async () => {
      for (;;) {
        const saved = await ctx.jobs.list();
        const [head] = queueOf(saved, agentId);
        if (!head) return;
        const snapshot = await snapshotBeforeSend(
          ctx.server,
          agentId,
          inFlightIds(saved, agentId),
          signal,
        );
        if (snapshot.botBusy) return;
        let refused: GrokBotError | undefined;
        try {
          refused = await sendQueued(ctx, head, snapshot, signal);
        } catch (error) {
          if (head.jobId === own || signal?.aborted) throw error;
          return;
        }
        if (refused === undefined) return;
        if (head.jobId === own) throw refused;
      }
    },
    signal,
  );
}

/**
 * Sends queued job `jobId` now, under the bot's lock, even while the bot is busy: the caller
 * chose to reach the bot during its current work. The snapshot still records whether the bot
 * was busy, so a run that answers this message together with another ends ambiguous. Jobs
 * queued earlier keep their place. A refusal is thrown.
 */
export function sendAtOnce(
  ctx: JobContext,
  agentId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  return withAgentLock(
    ctx.jobs.dir,
    agentId,
    async () => {
      const saved = await ctx.jobs.list();
      const job = saved.find((j) => j.jobId === jobId);
      if (job?.state.status !== "queued") return;
      const snapshot = await snapshotBeforeSend(
        ctx.server,
        agentId,
        inFlightIds(saved, agentId),
        signal,
      );
      const refused = await sendQueued(ctx, job, snapshot, signal);
      if (refused !== undefined) throw refused;
    },
    signal,
  );
}

/**
 * Replaces the text of a message still waiting in the queue, under the bot's lock so the
 * queue never sends it while it changes. Refuses a job whose message already went out (a
 * reply quotes it instead) or never will.
 */
export function editQueued(
  ctx: JobContext,
  job: JobRecord,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const name = job.agentName ?? "the bot";
  return withAgentLock(
    ctx.jobs.dir,
    job.agentId,
    async () => {
      const now = await ctx.jobs.load(job.jobId);
      if (!now)
        throw new GrokBotError("not-found", `job ${job.jobId} left the store`);
      const { state } = now;
      if (state.status === "queued") {
        await ctx.jobs.save({ ...now, text });
        return;
      }
      if (state.status === "failed" && state.notSent) {
        throw new GrokBotError(
          "not-found",
          `Job ${job.jobId} was never sent (${state.error}), so there is nothing to edit. Send the new text with grokbot send.`,
        );
      }
      throw new GrokBotError(
        "not-found",
        `Job ${job.jobId} already went to ${name}, so its message can no longer change. Reply to it instead with grokbot reply ${job.jobId} "<text>" (add --now to reach the bot during its current work).`,
      );
    },
    signal,
  );
}

/**
 * Waits until queued `job` is sent, advancing the bot's queue whenever the bot is free.
 * Returns the job as saved: still queued when the deadline passes first.
 */
export async function untilSent(
  ctx: JobContext,
  job: JobRecord,
  deadlineMs: number,
  signal?: AbortSignal,
  onEvent?: (event: QueuedEvent) => void,
): Promise<JobRecord> {
  let announced = false;
  for (;;) {
    await advanceQueue(ctx, job.agentId, job.jobId, signal);
    const saved = await ctx.jobs.list();
    const now = saved.find((j) => j.jobId === job.jobId);
    if (!now)
      throw new GrokBotError("not-found", `job ${job.jobId} left the store`);
    if (now.state.status !== "queued") return now;
    if (!announced) {
      const queue = queueOf(saved, job.agentId);
      const ahead = queue.findIndex((j) => j.jobId === job.jobId);
      const { jobId, agentId } = job;
      onEvent?.({ type: "queued", jobId, agentId, ahead });
      announced = true;
    }
    const left = deadlineMs - Date.now();
    if (left <= 0) return now;
    await delay(Math.min(POLL_MS, left), undefined, { signal });
  }
}
