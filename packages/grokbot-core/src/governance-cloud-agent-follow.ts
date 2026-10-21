import type { RunnerContext } from "./command-runner-context.js";
import type { Sleep } from "./governance-cloud-agent-handlers.js";
import {
  applyChange,
  type CloudAgentOutcome,
  type CloudAgentWatch,
  judgeWatch,
  parseUpdateFrame,
  watchOf,
} from "./governance-cloud-agent-updates.js";
import type { CloudAgentInfo } from "./governance-cloud-agents.js";
import { isFatal } from "./wait-reconnect.js";

/** Rows the stream's snapshot carries; the app asks for the same. */
const SNAPSHOT_N = 50;
/** The server heartbeats well inside this; a connection silent for it is dead (the app's idle watchdog). */
const IDLE_MS = 45_000;
/** Reconnect pause: 1 s doubling to 60 s with equal jitter, as the app's policy. */
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_LAST_MS = 60_000;
/** The polling fallback first reads after 5 s and backs off to one read every 30 s. */
const FIRST_POLL_MS = 5_000;
const LAST_POLL_MS = 30_000;

export interface FollowOptions {
  readonly ctx: RunnerContext;
  readonly sleep: Sleep;
  readonly bcId: string;
  readonly timeoutS: number;
  readonly signal?: AbortSignal;
  /** GetBackgroundComposerInfo for this agent. */
  readonly readInfo: (signal?: AbortSignal) => Promise<CloudAgentInfo>;
}

export interface Followed {
  readonly info: CloudAgentInfo;
  readonly outcome: CloudAgentOutcome;
}

type Attempt =
  | { readonly kind: "verdict"; readonly outcome: CloudAgentOutcome }
  | { readonly kind: "timeout" }
  /** The connection ended or went quiet after `frames` frames; `clean` when the server closed it. */
  | {
      readonly kind: "dropped";
      readonly frames: number;
      readonly clean: boolean;
    };

/** What the follow knows between connections. */
interface Progress {
  watch: CloudAgentWatch;
  cursor: string | undefined;
}

const STALLED = Symbol("stalled");

/** Equal jitter: half the pause fixed, the other half random. */
const jittered = (ms: number): number =>
  Math.round(ms / 2 + (Math.random() * ms) / 2);

const reconnectPause = (failures: number): number =>
  jittered(
    Math.min(
      RECONNECT_FIRST_MS * 2 ** Math.max(failures - 1, 0),
      RECONNECT_LAST_MS,
    ),
  );

const pendingAfter = (info: CloudAgentInfo, timeoutS: number): Followed => ({
  info,
  outcome: {
    status: "pending",
    reason: `still ${info.status} after ${timeoutS} s`,
  },
});

/** The timeout passed: read where the agent stands once more, and judge that. */
async function expire(o: FollowOptions): Promise<Followed> {
  const info = await o.readInfo(o.signal);
  const outcome = judgeWatch(watchOf(info));
  return outcome ? { info, outcome } : pendingAfter(info, o.timeoutS);
}

/** Polls GetBackgroundComposerInfo until the agent is judged or `deadline` passes. */
async function poll(o: FollowOptions, deadline: number): Promise<Followed> {
  for (let pause = FIRST_POLL_MS; ; pause = Math.min(pause * 2, LAST_POLL_MS)) {
    const info = await o.readInfo(o.signal);
    const outcome = judgeWatch(watchOf(info));
    if (outcome) return { info, outcome };
    const left = deadline - o.ctx.now();
    if (left <= 0) return pendingAfter(info, o.timeoutS);
    await o.sleep(Math.min(pause, left), o.signal);
  }
}

/**
 * One connection: applies each frame to `progress` until the agent is judged, the stream
 * ends or goes silent for IDLE_MS, or `deadline` passes. Every frame, heartbeats
 * included, restarts the idle watchdog.
 */
async function connect(
  o: FollowOptions,
  deadline: number,
  progress: Progress,
): Promise<Attempt> {
  const stop = new AbortController();
  let frames: AsyncIterator<unknown> | undefined;
  let count = 0;
  try {
    frames = o.ctx.composer
      .stream(
        "StreamBackgroundComposerUpdates",
        {
          snapshotN: SNAPSHOT_N,
          ...(progress.cursor !== undefined && {
            resumeCursor: progress.cursor,
          }),
        },
        {
          signal: o.signal
            ? AbortSignal.any([o.signal, stop.signal])
            : stop.signal,
        },
      )
      [Symbol.asyncIterator]();
    for (;;) {
      const left = deadline - o.ctx.now();
      if (left <= 0) return { kind: "timeout" };
      const watchdog = new AbortController();
      const silent = o
        .sleep(Math.min(IDLE_MS, left), watchdog.signal)
        .then((): typeof STALLED => STALLED);
      const next = frames.next();
      // The loser of the race settles later; neither may end up unhandled.
      silent.catch(() => undefined);
      next.catch(() => undefined);
      let step: IteratorResult<unknown> | typeof STALLED;
      try {
        step = await Promise.race([next, silent]);
      } finally {
        watchdog.abort();
      }
      if (step === STALLED) {
        o.signal?.throwIfAborted();
        return o.ctx.now() >= deadline
          ? { kind: "timeout" }
          : { kind: "dropped", frames: count, clean: false };
      }
      if (step.done) {
        o.signal?.throwIfAborted();
        return { kind: "dropped", frames: count, clean: true };
      }
      count++;
      const frame = parseUpdateFrame(step.value, o.bcId);
      if (frame.cursor !== undefined) progress.cursor = frame.cursor;
      if (!frame.change) continue;
      progress.watch = applyChange(progress.watch, frame.change);
      const outcome = judgeWatch(progress.watch);
      if (outcome) return { kind: "verdict", outcome };
    }
  } catch (error) {
    o.signal?.throwIfAborted();
    if (isFatal(error)) throw error;
    return { kind: "dropped", frames: count, clean: false };
  } finally {
    stop.abort();
    // Not awaited: a read still pending only ends once the abort lands.
    frames?.return?.()?.catch(() => undefined);
  }
}

/**
 * Follows one cloud agent until it stops running, needs the user, or `timeoutS` passes.
 *
 * It starts from a fresh GetBackgroundComposerInfo (the agent may be older than the
 * stream's snapshot rows), then follows StreamBackgroundComposerUpdates: the snapshot row
 * and the events of this agent update what is known. A connection that drops after
 * delivering frames reopens from its resume cursor after a backoff pause. One that
 * delivers nothing is retried without the cursor, and a first connection that delivers
 * nothing falls back to polling GetBackgroundComposerInfo.
 */
export async function followCloudAgent(o: FollowOptions): Promise<Followed> {
  const deadline = o.ctx.now() + o.timeoutS * 1000;
  const first = await o.readInfo(o.signal);
  const settled = judgeWatch(watchOf(first));
  if (settled) return { info: first, outcome: settled };
  const progress: Progress = { watch: watchOf(first), cursor: undefined };
  let failures = 0;
  for (;;) {
    if (deadline - o.ctx.now() <= 0) return expire(o);
    const attempt = await connect(o, deadline, progress);
    if (attempt.kind === "timeout") return expire(o);
    if (attempt.kind === "verdict") {
      // Show the agent as the stream left it, even if the read is a moment behind.
      const info = await o.readInfo(o.signal);
      return {
        info: {
          ...info,
          status: progress.watch.status,
          needsYou: progress.watch.needsYou,
        },
        outcome: attempt.outcome,
      };
    }
    if (attempt.frames === 0) {
      if (progress.cursor === undefined) return poll(o, deadline);
      // The server refused the cursor, or lost what came after it: start over without it,
      // from where the agent stands now.
      progress.cursor = undefined;
      const info = await o.readInfo(o.signal);
      const outcome = judgeWatch(watchOf(info));
      if (outcome) return { info, outcome };
      progress.watch = watchOf(info);
      continue;
    }
    failures = attempt.clean ? 0 : failures + 1;
    await o.sleep(
      Math.min(reconnectPause(failures), Math.max(deadline - o.ctx.now(), 0)),
      o.signal,
    );
  }
}
