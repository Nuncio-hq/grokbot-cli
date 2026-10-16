import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

export type JobState =
  /** Not sent yet: the bot was busy, so the message waits its turn (job-queue.ts). */
  | { readonly status: "queued" }
  /** Saved before SendGrokBotUserMessage; the message may or may not have landed. */
  | { readonly status: "sending" }
  | { readonly status: "pending" }
  | { readonly status: "awaiting-approval"; readonly reason: string }
  | { readonly status: "done"; readonly finalReply: string }
  /** The turn ended, but one run may have answered this message with another (turn-sharing.ts). */
  | {
      readonly status: "ambiguous";
      readonly reason: string;
      readonly replyText: string;
    }
  /** `notSent`: the message never went out (refused, or unsendable), so there is nothing to wait for. */
  | {
      readonly status: "failed";
      readonly error: string;
      readonly notSent?: boolean;
    };

/** A dispatched message we can resume waiting on. Holds no credentials. */
export interface JobRecord {
  readonly jobId: string;
  readonly agentId: string;
  /** The agent's name at send time, for messages; absent on jobs saved before 16 Oct 2026. */
  readonly agentName?: string;
  /** The message, kept until it is sent so another process can send it (and on a refusal). */
  readonly text?: string;
  /** When the message joined the bot's queue; queued jobs go out oldest first. */
  readonly queuedAtMs?: number;
  readonly sentMessageId: string;
  /** When the message was sent; while queued, when it was queued. */
  readonly sentAtMs: number;
  /** Highest transcript updatedSeq seen before the send ("0" while queued); the wait reads after it. */
  readonly baselineUpdatedSeq: string;
  readonly generation: string;
  /**
   * Whether the bot was busy (mid-run, or a message still unanswered) just before the
   * send. Absent when unknown, which the Done Rule treats as busy (turn-sharing.ts).
   */
  readonly botBusyAtSend?: boolean;
  readonly state: JobState;
}

/** Done and ambiguous jobs are final: the turn ended, and a later wait returns them as saved. */
export const isFinalState = (state: JobState): boolean =>
  state.status === "done" || state.status === "ambiguous";

export const DEFAULT_JOBS_DIR = join(homedir(), ".grokbot", "jobs");

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INT64 = /^\d+$/;

function checkId(jobId: string): string {
  if (!SAFE_ID.test(jobId))
    throw new GrokBotError("protocol", `invalid job id: ${jobId}`);
  return jobId;
}

function pickState(state: JobState): JobState {
  switch (state.status) {
    case "queued":
    case "sending":
    case "pending":
      return { status: state.status };
    case "awaiting-approval":
      return { status: state.status, reason: state.reason };
    case "done":
      return { status: state.status, finalReply: state.finalReply };
    case "ambiguous":
      return {
        status: state.status,
        reason: state.reason,
        replyText: state.replyText,
      };
    case "failed":
      return {
        status: state.status,
        error: state.error,
        ...(state.notSent === true && { notSent: true }),
      };
  }
}

/** Copies only the declared keys, so stray fields (a token, say) never reach disk. */
function pickRecord(job: JobRecord): JobRecord {
  return {
    jobId: job.jobId,
    agentId: job.agentId,
    ...(job.agentName !== undefined && { agentName: job.agentName }),
    ...(job.text !== undefined && { text: job.text }),
    ...(job.queuedAtMs !== undefined && { queuedAtMs: job.queuedAtMs }),
    sentMessageId: job.sentMessageId,
    sentAtMs: job.sentAtMs,
    baselineUpdatedSeq: job.baselineUpdatedSeq,
    generation: job.generation,
    ...(job.botBusyAtSend !== undefined && {
      botBusyAtSend: job.botBusyAtSend,
    }),
    state: pickState(job.state),
  };
}

function parseState(raw: unknown): JobState | undefined {
  const o = asJsonObject(raw);
  const status = o ? readString(o, "status") : undefined;
  if (!o || status === undefined) return undefined;
  const field = (key: string) => readString(o, key);
  if (status === "queued" || status === "sending" || status === "pending")
    return { status };
  if (status === "awaiting-approval")
    return { status, reason: field("reason") ?? "" };
  const finalReply = field("finalReply");
  if (status === "done" && finalReply !== undefined)
    return { status, finalReply };
  const [reason, replyText] = [field("reason"), field("replyText")];
  if (status === "ambiguous" && reason !== undefined && replyText !== undefined)
    return { status, reason, replyText };
  const error = field("error");
  if (status === "failed" && error !== undefined)
    return { status, error, ...(o.notSent === true && { notSent: true }) };
  return undefined;
}

export function parseJobRecord(raw: unknown): JobRecord {
  const o: JsonObject = asJsonObject(raw) ?? {};
  const str = (key: string) => readString(o, key);
  const [jobId, agentId, sentMessageId] = [
    str("jobId"),
    str("agentId"),
    str("sentMessageId"),
  ];
  const [baselineUpdatedSeq, generation] = [
    str("baselineUpdatedSeq"),
    str("generation"),
  ];
  const state = parseState(o.state);
  const sentAtMs = o.sentAtMs;
  if (
    !jobId ||
    !agentId ||
    !sentMessageId ||
    !state ||
    typeof sentAtMs !== "number" ||
    !baselineUpdatedSeq ||
    !INT64.test(baselineUpdatedSeq) ||
    !generation ||
    !INT64.test(generation)
  ) {
    throw new GrokBotError(
      "protocol",
      `corrupt job record ${jobId ?? "(no id)"}`,
    );
  }
  const [agentName, text] = [str("agentName"), str("text")];
  const { botBusyAtSend: busy, queuedAtMs } = o;
  return {
    jobId,
    agentId,
    ...(agentName !== undefined && { agentName }),
    ...(text !== undefined && { text }),
    ...(typeof queuedAtMs === "number" && { queuedAtMs }),
    sentMessageId,
    sentAtMs,
    baselineUpdatedSeq,
    generation,
    ...(typeof busy === "boolean" && { botBusyAtSend: busy }),
    state,
  };
}

export interface JobStore {
  readonly dir: string;
  /** Writes the record atomically. A job saved as done or ambiguous stays so: later saves are ignored. */
  save(job: JobRecord): Promise<void>;
  load(jobId: string): Promise<JobRecord | null>;
  list(): Promise<JobRecord[]>;
  /** Deletes the record; a missing record is not an error. */
  remove(jobId: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

export function jobStore(dir: string = DEFAULT_JOBS_DIR): JobStore {
  const pathOf = (jobId: string) => join(dir, `${checkId(jobId)}.json`);

  async function load(jobId: string): Promise<JobRecord | null> {
    const path = pathOf(jobId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      return parseJobRecord(JSON.parse(text));
    } catch (cause) {
      throw new GrokBotError("protocol", `corrupt job file ${path}`, { cause });
    }
  }

  return {
    dir,
    async save(job) {
      const path = pathOf(job.jobId);
      const saved = await load(job.jobId).catch(() => null);
      if (saved && isFinalState(saved.state)) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${job.jobId}.json.${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, `${JSON.stringify(pickRecord(job), null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
    },
    load,
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const ids = names
        .filter((n) => n.endsWith(".json") && SAFE_ID.test(n.slice(0, -5)))
        .map((n) => n.slice(0, -5))
        .sort();
      const jobs = await Promise.all(ids.map(load));
      return jobs.filter((j): j is JobRecord => j !== null);
    },
    async remove(jobId) {
      await rm(pathOf(jobId), { force: true });
    },
  };
}
