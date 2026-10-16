import { randomUUID } from "node:crypto";
import type { Agent } from "./agents.js";
import type { JobOutcome, RunOptions } from "./command-runner-contract.js";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { snapshotBeforeSend } from "./job-send-snapshot.js";
import {
  isFinalState,
  type JobRecord,
  type JobState,
  type JobStore,
} from "./job-store.js";
import { asJsonObject, readString } from "./transcript.js";
import type { BusyAtSend } from "./turn-sharing.js";
import { waitForDone } from "./wait-for-done.js";

export interface JobContext {
  readonly server: ServerTransport;
  readonly jobs: JobStore;
}

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

/**
 * Records the transcript baseline and whether the bot is busy, saves the job as sending,
 * sends `text`, and saves it as pending once accepted. A refused message leaves no job.
 * Any other send error keeps the sending record: the message may have landed, and
 * `wait` finds its echo.
 */
export async function dispatchMessage(
  { server, jobs }: JobContext,
  agent: Agent,
  text: string,
  signal?: AbortSignal,
): Promise<JobRecord> {
  const { agentId } = agent;
  const { baseline, botBusy } = await snapshotBeforeSend(
    server,
    agentId,
    signal,
  );
  const job: JobRecord = {
    jobId: randomUUID(),
    agentId,
    agentName: agent.name,
    sentMessageId: randomUUID(),
    sentAtMs: Date.now(),
    baselineUpdatedSeq: baseline.afterUpdatedSeq,
    generation: baseline.generation,
    botBusyAtSend: botBusy,
    state: { status: "sending" },
  };
  await jobs.save(job);
  const response = await server.call(
    "SendGrokBotUserMessage",
    {
      agentId,
      messageId: job.sentMessageId,
      text,
      sentAtMs: String(job.sentAtMs),
      sessionId: "",
    },
    { signal },
  );
  try {
    assertDispatched(response);
  } catch (refused) {
    await jobs.remove(job.jobId);
    throw refused;
  }
  const pending: JobRecord = { ...job, state: { status: "pending" } };
  await jobs.save(pending);
  return pending;
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
async function busyRecords(jobs: JobStore, job: JobRecord) {
  const saved = await jobs.list().catch(() => []);
  const busy = new Map<string, boolean>();
  for (const j of [...saved, job]) {
    if (j.agentId === job.agentId && j.botBusyAtSend !== undefined)
      busy.set(j.sentMessageId, j.botBusyAtSend);
  }
  return busy satisfies BusyAtSend;
}

/**
 * Waits for the job's turn and saves where it stands. A job saved as done or ambiguous
 * returns its saved result without touching the network. A timeout becomes a pending
 * outcome; a caller abort leaves the saved state alone so `wait` can resume.
 */
export async function followJob(
  { server, jobs }: JobContext,
  job: JobRecord,
  timeoutSeconds: number,
  { signal, onEvent }: RunOptions,
): Promise<JobOutcome> {
  const saved = isFinalState(job.state) ? savedOutcome(job.state) : undefined;
  if (saved) return saved;
  let outcome: JobOutcome;
  try {
    outcome = await waitForDone({
      server,
      job: { ...job, busyAtSend: await busyRecords(jobs, job) },
      timeoutMs: timeoutSeconds * 1000,
      signal,
      onEvent,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!(error instanceof GrokBotError && error.code === "timeout")) {
      const message = error instanceof Error ? error.message : String(error);
      await jobs.save({ ...job, state: { status: "failed", error: message } });
      throw error;
    }
    outcome = { status: "pending", reason: error.message };
  }
  await jobs.save({ ...job, state: stateOf(outcome) });
  return outcome;
}
