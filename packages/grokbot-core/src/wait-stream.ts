import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import type { DoneVerdict } from "./done-rule.js";
import { type StreamEvent, watchTranscripts } from "./transcript-stream.js";
import { abortable } from "./wait-reconnect.js";
import type { SettledVerdict, WaitSession } from "./wait-session.js";
import { settlementFailure } from "./wait-turn-failure.js";

export type StreamEnd =
  | { readonly type: "verdict"; readonly verdict: SettledVerdict }
  | { readonly type: "ended" }
  | { readonly type: "cursor-too-old" }
  /** A turnFailed frame: fails the turn once the bot is idle with no final reply. */
  | { readonly type: "turn-failed"; readonly raw: JsonObject }
  /** The server settled the turn with an error or a cancellation and no reply answers it. */
  | { readonly type: "settled-failure"; readonly raw: JsonObject };

interface StreamFollowOptions {
  readonly server: ServerTransport;
  readonly signal: AbortSignal;
  /** How long a done verdict seen on the stream must go without new rows. */
  readonly quietWindowMs: number;
  readonly onEvent?: (event: StreamEvent) => void;
}

/**
 * A streamed status can run ahead of the rows it covers, so a verdict seen on the
 * stream is only a candidate. A done (or ambiguous) must go the quiet window without
 * new rows, an approval needs no wait, and both are then confirmed by reading the rows
 * again. When the server has settled the turn's run, a done needs no quiet window, and a
 * failure it settled the turn with is a candidate that waits for nothing either: the
 * read confirms there is still no reply.
 */
class Candidate {
  #deadline: number | undefined;
  #key: string | undefined;

  constructor(private readonly quietMs: number) {}

  get deadline(): number | undefined {
    return this.#deadline;
  }

  consider(
    verdict: DoneVerdict,
    server: Pick<WaitSession, "settled" | "failure">,
  ): void {
    const failed = server.failure !== undefined;
    if (verdict.status === "running" && !failed) {
      this.drop();
      return;
    }
    const key = failed
      ? "failed"
      : `${verdict.status}${server.settled ? "+settled" : ""}`;
    if (this.#key === key) return;
    this.#key = key;
    const ended = verdict.status === "done" || verdict.status === "ambiguous";
    this.#deadline = Date.now() + (ended && !server.settled ? this.quietMs : 0);
  }

  drop(): void {
    this.#deadline = undefined;
    this.#key = undefined;
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

const earliest = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined ? (a ?? b) : Math.min(a, b);

async function until<T>(
  pending: Promise<T>,
  deadline: number | undefined,
): Promise<T | typeof DEADLINE> {
  if (deadline === undefined) return pending;
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), DEADLINE);
  });
  try {
    return await Promise.race([pending, elapsed]);
  } finally {
    clearTimeout(timer);
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
  await session.syncDelegates();
  await session.confirmSubagentList();
  candidate.consider(session.settle(), session);
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
        if (!added) {
          if (verdict.status !== "running") return { type: "verdict", verdict };
          const { failure } = session;
          if (failure)
            return { type: "settled-failure", raw: settlementFailure(failure) };
        }
        candidate.drop();
        candidate.consider(verdict, session);
        continue;
      }
      if (session.delegatesDue()) {
        await session.syncDelegates(true);
        candidate.consider(session.settle(), session);
        continue;
      }
      if (session.subagentsDue()) {
        await session.syncSubagents();
        candidate.consider(session.settle(), session);
        continue;
      }
      pending ??= abortable(events.next(), signal);
      const next = await until(
        pending,
        earliest(
          candidate.deadline,
          earliest(session.delegatesDueAtMs, session.subagentsDueAtMs),
        ),
      );
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
