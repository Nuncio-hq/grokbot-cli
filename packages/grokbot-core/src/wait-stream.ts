import { setTimeout as delay } from "node:timers/promises";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import type { DoneVerdict } from "./done-rule.js";
import { type StreamEvent, watchTranscripts } from "./transcript-stream.js";
import { abortable } from "./wait-reconnect.js";
import type { SettledVerdict, WaitSession } from "./wait-session.js";

export type StreamEnd =
  | { readonly type: "verdict"; readonly verdict: SettledVerdict }
  | { readonly type: "ended" }
  | { readonly type: "cursor-too-old" }
  | { readonly type: "turn-failed"; readonly raw: JsonObject };

export interface StreamFollowOptions {
  readonly server: ServerTransport;
  readonly signal: AbortSignal;
  /** How long a done verdict seen on the stream must go without new rows. */
  readonly quietWindowMs: number;
  readonly onEvent?: (event: StreamEvent) => void;
}

/**
 * A streamed status can run ahead of the rows it covers, so a verdict seen on the
 * stream is only a candidate. A done (or ambiguous) must go the quiet window without
 * new rows, an approval needs no wait, and both are then confirmed by reading the rows again.
 */
class Candidate {
  #deadline: number | undefined;
  #status: DoneVerdict["status"] | undefined;

  constructor(private readonly quietMs: number) {}

  get deadline(): number | undefined {
    return this.#deadline;
  }

  consider(verdict: DoneVerdict): void {
    if (verdict.status === "running") {
      this.drop();
      return;
    }
    if (this.#status === verdict.status) return;
    this.#status = verdict.status;
    const ended = verdict.status === "done" || verdict.status === "ambiguous";
    this.#deadline = Date.now() + (ended ? this.quietMs : 0);
  }

  drop(): void {
    this.#deadline = undefined;
    this.#status = undefined;
  }

  /** The stream ended, so no row can arrive on it: confirm now. */
  expire(): void {
    if (this.#deadline !== undefined) this.#deadline = Date.now();
  }

  due(): boolean {
    return this.#deadline !== undefined && Date.now() >= this.#deadline;
  }
}

const DEADLINE = Symbol("deadline");

async function until<T>(
  pending: Promise<T>,
  deadline: number | undefined,
): Promise<T | typeof DEADLINE> {
  if (deadline === undefined) return pending;
  const timer = new AbortController();
  const ms = Math.max(0, deadline - Date.now());
  const elapsed = delay(ms, DEADLINE, { signal: timer.signal });
  try {
    return await Promise.race([pending, elapsed]);
  } finally {
    timer.abort();
  }
}

/** Applies one event for the target; returns how the stream ends when this event ends it. */
async function apply(
  session: WaitSession,
  event: StreamEvent,
  candidate: Candidate,
): Promise<StreamEnd | undefined> {
  if (!("agentId" in event) || event.agentId !== session.agentId)
    return undefined;
  switch (event.type) {
    case "rows":
      if (!session.addRows(event.entries)) return undefined;
      candidate.drop();
      break;
    case "agent-state":
      await session.recordStatus(event.status);
      break;
    case "cleared":
      throw new GrokBotError(
        "not-found",
        `transcript of ${session.agentId} was cleared while waiting`,
      );
    case "cursor-too-old":
      return { type: "cursor-too-old" };
    case "turn-failed":
      return { type: "turn-failed", raw: event.raw };
  }
  candidate.consider(session.settle());
  return undefined;
}

/** Follows WatchGrokBotTranscripts from the session cursor until a confirmed verdict or the stream ends. */
export async function followStream(
  session: WaitSession,
  options: StreamFollowOptions,
): Promise<StreamEnd> {
  const { server, signal } = options;
  const stream = new AbortController();
  const stop = () => stream.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const events = watchTranscripts(server, [session.cursor], {
    signal: stream.signal,
  })[Symbol.asyncIterator]();
  const candidate = new Candidate(options.quietWindowMs);
  let pending: Promise<IteratorResult<StreamEvent>> | undefined;
  try {
    for (;;) {
      if (candidate.due()) {
        const added = await session.readRows();
        const verdict = session.settle();
        if (verdict.status !== "running" && !added)
          return { type: "verdict", verdict };
        candidate.drop();
        candidate.consider(verdict);
        continue;
      }
      pending ??= abortable(events.next(), signal);
      const next = await until(pending, candidate.deadline);
      if (next === DEADLINE) continue;
      pending = undefined;
      if (next.done) {
        if (candidate.deadline === undefined) return { type: "ended" };
        candidate.expire();
        continue;
      }
      options.onEvent?.(next.value);
      const end = await apply(session, next.value, candidate);
      if (end) return end;
    }
  } finally {
    stream.abort();
    signal.removeEventListener("abort", stop);
  }
}
