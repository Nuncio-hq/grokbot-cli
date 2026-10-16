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
export function assertDispatched(raw: unknown): void {
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

/** A job for `text` that waits its turn; the snapshot fields are filled when it is sent. */
export function newQueuedJob(agent: Agent, text: string): JobRecord {
  const now = Date.now();
  return {
    jobId: randomUUID(),
    agentId: agent.agentId,
    agentName: agent.name,
    text,
    queuedAtMs: now,
    sentMessageId: randomUUID(),
    sentAtMs: now,
    baselineUpdatedSeq: "0",
    generation: "0",
    state: { status: "queued" },
  };
}

/** The bot's queued jobs, oldest first. */
export function queueOf(
  saved: readonly JobRecord[],
  agentId: string,
): JobRecord[] {
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
