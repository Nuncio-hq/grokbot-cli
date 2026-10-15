import { setTimeout as delay } from "node:timers/promises";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import type { DoneVerdict } from "./done-rule.js";
import type { FetchLike } from "./server-transport.js";
import type { StreamEvent } from "./transcript-stream.js";
import {
  cursorTooOldGuard,
  isFatal,
  reconnectBackoff,
} from "./wait-reconnect.js";
import {
  type SettledVerdict,
  type WaitJob,
  WaitSession,
} from "./wait-session.js";
import { followStream, type StreamEnd } from "./wait-stream.js";
import { turnFailedError } from "./wait-turn-failure.js";

export type { WaitJob } from "./wait-session.js";

export type WaitResult = SettledVerdict;

export type WaitEvent =
  | { readonly type: "verdict"; readonly verdict: DoneVerdict }
  | { readonly type: "stream"; readonly event: StreamEvent }
  | { readonly type: "reconnecting"; readonly reason: string };

export interface WaitForDoneOptions {
  readonly server: ServerTransport;
  readonly job: WaitJob;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: WaitEvent) => void;
  /** First pause between reconnects; doubles per attempt up to 15 s. Default 1000 ms. */
  readonly reconnectDelayMs?: number;
  /** Rows asked for in the backlog call. Default 50. */
  readonly backlogLimit?: number;
  /** How long a done seen on the stream must go without new rows. Default 1500 ms. */
  readonly quietWindowMs?: number;
  /** Downloads a final reply stored as a blob. Default global fetch. */
  readonly fetch?: FetchLike;
}

const TIMED_OUT = Symbol("timed-out");

function verdictKey(v: DoneVerdict): string {
  if (v.status === "running") return `running, ${v.reason}`;
  if (v.status === "done") return `done: ${v.finalReply}`;
  return `awaiting-approval: ${v.reason} (${v.cards.length})`;
}

/**
 * Waits until the turn started by `job.sentMessageId` is done or blocked on the owner.
 * Each attempt reads the live status, then the rows, so the rows are never older than
 * the status; then it follows WatchGrokBotTranscripts from the highest updatedSeq seen.
 * Throws GrokBotError("protocol") when the bot reports a failed turn and then
 * sits idle without a final reply.
 */
export async function waitForDone(
  options: WaitForDoneOptions,
): Promise<WaitResult> {
  const { signal, timeoutMs } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMED_OUT), timeoutMs);
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const progress: { last?: DoneVerdict } = {};
  try {
    return await follow(options, controller.signal, progress);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (controller.signal.reason !== TIMED_OUT) throw controller.signal.reason;
    const last = progress.last ? verdictKey(progress.last) : "none";
    throw new GrokBotError(
      "timeout",
      `no Done verdict within ${timeoutMs} ms (last: ${last})`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

async function follow(
  options: WaitForDoneOptions,
  signal: AbortSignal,
  progress: { last?: DoneVerdict },
): Promise<WaitResult> {
  const { server, job, onEvent } = options;
  const backoff = reconnectBackoff(options.reconnectDelayMs ?? 1000);
  const checkCursorTooOld = cursorTooOldGuard(job.agentId);
  const session = new WaitSession({
    server,
    job,
    signal,
    backlogLimit: options.backlogLimit ?? 50,
    fetch: options.fetch,
    report: (verdict) => {
      if (!progress.last || verdictKey(progress.last) !== verdictKey(verdict))
        onEvent?.({ type: "verdict", verdict });
      progress.last = verdict;
    },
    onNewRows: () => backoff.reset(),
  });
  const streamOptions = {
    server,
    signal,
    quietWindowMs: options.quietWindowMs ?? 1500,
    onEvent: (event: StreamEvent) => onEvent?.({ type: "stream", event }),
  };

  let turnFailure: JsonObject | undefined;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await delay(backoff.next(), undefined, { signal });
    let end: StreamEnd | undefined;
    let failed: JsonObject | undefined;
    try {
      await session.refreshStatus();
      await session.readRows();
      let verdict = session.settle();
      if (verdict.status !== "running") verdict = await session.finish(verdict);
      if (verdict.status !== "running") return verdict;
      // Before our echo the failure is not ours yet, and an open delegation wakes
      // the bot again on the delegate's reply, so only a stalled final reply fails.
      if (turnFailure && verdict.reason === "awaiting-final-reply")
        failed = turnFailure;
      else {
        turnFailure = undefined;
        end = await followStream(session, streamOptions);
      }
    } catch (error) {
      if (signal.aborted || isFatal(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: "reconnecting", reason });
    }
    if (failed) throw turnFailedError(job.agentId, failed);
    if (end?.type === "verdict") {
      const verdict = await session.finish(end.verdict);
      if (verdict.status !== "running") return verdict;
    }
    if (end?.type === "turn-failed") turnFailure = end.raw;
    if (end?.type === "cursor-too-old") {
      checkCursorTooOld(session.rows.cursor);
      session.requireBacklog();
    }
  }
}
