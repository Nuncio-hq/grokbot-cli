import { randomUUID } from "node:crypto";
import type { Agent } from "./agents.js";
import type { JobOutcome, RunOptions } from "./command-runner-contract.js";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import type { JobRecord, JobState, JobStore } from "./job-store.js";
import {
  asJsonObject,
  parseEntriesResponse,
  readString,
} from "./transcript.js";
import { transcriptCursor } from "./transcript-stream.js";
import { waitForDone } from "./wait-for-done.js";

export interface JobContext {
  readonly server: ServerTransport;
  readonly jobs: JobStore;
}

/** Enough recent rows to find the highest updatedSeq before our message lands. */
const BASELINE_ROWS = 5;

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
 * Records the transcript baseline, saves the job as sending, sends `text`, and saves
 * it as pending once accepted. A refused message leaves no job. Any other send error
 * keeps the sending record: the message may have landed, and `wait` finds its echo.
 */
export async function dispatchMessage(
  { server, jobs }: JobContext,
  agent: Agent,
  text: string,
  signal?: AbortSignal,
): Promise<JobRecord> {
  const { agentId } = agent;
  const recent = parseEntriesResponse(
    await server.call(
      "ListGrokBotTranscriptEntries",
      { agentId, sessionId: "", limit: BASELINE_ROWS },
      { signal },
    ),
  );
  const baseline = transcriptCursor(agentId, recent);
  const job: JobRecord = {
    jobId: randomUUID(),
    agentId,
    sentMessageId: randomUUID(),
    sentAtMs: Date.now(),
    baselineUpdatedSeq: baseline.afterUpdatedSeq,
    generation: baseline.generation,
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
    case "awaiting-approval":
      return { status: "awaiting-approval", reason: outcome.reason };
    case "pending":
      return { status: "pending" };
  }
}

/**
 * Waits for the job's turn and saves where it stands. A job saved as done returns
 * its saved reply without touching the network. A timeout becomes a pending
 * outcome; a caller abort leaves the saved state alone so `wait` can resume.
 */
export async function followJob(
  { server, jobs }: JobContext,
  job: JobRecord,
  timeoutSeconds: number,
  { signal, onEvent }: RunOptions,
): Promise<JobOutcome> {
  if (job.state.status === "done") {
    return { status: "done", finalReply: job.state.finalReply, replies: [] };
  }
  let outcome: JobOutcome;
  try {
    outcome = await waitForDone({
      server,
      job,
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
