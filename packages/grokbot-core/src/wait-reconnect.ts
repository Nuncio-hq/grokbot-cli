import { GrokBotError, type GrokBotErrorCode } from "./contracts.js";
import type { Seq } from "./transcript.js";

const MAX_PAUSE_MS = 15_000;
const CURSOR_TOO_OLD_LIMIT = 3;
const FATAL_CODES: ReadonlySet<GrokBotErrorCode> = new Set([
  "auth",
  "not-found",
  "safety",
]);

/** Errors a retry cannot fix. Anything else reconnects. */
export function isFatal(error: unknown): boolean {
  return error instanceof GrokBotError && FATAL_CODES.has(error.code);
}

/** Pause before each reconnect: base, twice the base, and so on, capped at 15 s. */
export function reconnectBackoff(baseMs: number) {
  let attempt = 0;
  return {
    next(): number {
      const ms = Math.min(baseMs * 2 ** attempt, MAX_PAUSE_MS);
      attempt++;
      return ms;
    },
    /** New rows arrived, so the next pause is the base again. */
    reset(): void {
      attempt = 0;
    },
  };
}

/** Throws GrokBotError("protocol") once cursorTooOld repeats 3 times at the same cursor. */
export function cursorTooOldGuard(agentId: string) {
  let at: Seq | undefined;
  let count = 0;
  return (cursor: Seq): void => {
    count = cursor === at ? count + 1 : 1;
    at = cursor;
    if (count < CURSOR_TOO_OLD_LIMIT) return;
    throw new GrokBotError(
      "protocol",
      `transcript of ${agentId} reported cursorTooOld ${count} times at seq ${cursor}`,
    );
  };
}

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
