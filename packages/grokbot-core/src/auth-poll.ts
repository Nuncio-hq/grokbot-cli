import {
  type AuthEndpoints,
  apiUrlOf,
  authFetch,
  isPolicyBlocked,
  parseTokenPair,
  policyBlocked,
  type TokenPair,
} from "./auth-http.js";
import type { PkcePair } from "./auth-pkce.js";
import { GrokBotError } from "./contracts.js";

/** Same budget as the GrokBot app's login poll (`r1t` in main-app.cjs). */
const MAX_ATTEMPTS = 150;
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;
const BACKOFF = 1.2;
const MAX_FAILURES_IN_A_ROW = 3;

export interface PollOptions extends AuthEndpoints {
  readonly signal?: AbortSignal;
  /** Injected so tests never wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const delayFor = (attempt: number) =>
  Math.min(INITIAL_DELAY_MS * BACKOFF ** attempt, MAX_DELAY_MS);

/**
 * Polls `GET /auth/poll?uuid&verifier` until the owner finishes signing in on the
 * browser page. HTTP 404 means "not yet"; any other failure counts toward giving up.
 */
export async function pollLoginResult(
  pair: Pick<PkcePair, "uuid" | "verifier">,
  options: PollOptions = {},
): Promise<TokenPair> {
  const { signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  const url = new URL("/auth/poll", `${apiUrlOf(options)}/`);
  url.searchParams.set("uuid", pair.uuid);
  url.searchParams.set("verifier", pair.verifier);

  let failures = 0;
  let lastFailure = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    // A network error or a request timeout counts as one failure; Ctrl-C rethrows.
    const response = await authFetch(
      options,
      url.toString(),
      { headers: { "content-type": "application/json" }, signal },
      "Sign-in polling",
    ).catch((error: unknown) => {
      throwIfAborted(signal);
      return error instanceof Error ? error : new Error(String(error));
    });

    if (response instanceof Error) {
      failures++;
      lastFailure = response.message.includes("timed out")
        ? "timeout"
        : "network error";
    } else if (response.status === 404) {
      failures = 0;
      await discard(response);
    } else if (await isPolicyBlocked(response)) {
      throw policyBlocked();
    } else if (response.ok) {
      const pair = parseTokenPair(await response.json().catch(() => null));
      if (pair) return pair;
      throw new GrokBotError(
        "protocol",
        "Sign-in finished but the server returned no token pair.",
      );
    } else {
      failures++;
      lastFailure = `HTTP ${response.status}`;
      await discard(response);
    }

    if (failures >= MAX_FAILURES_IN_A_ROW) {
      throw new GrokBotError(
        "http",
        `Sign-in polling failed ${MAX_FAILURES_IN_A_ROW} times in a row (last: ${lastFailure}).`,
      );
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(delayFor(attempt), signal);
  }
  throw new GrokBotError(
    "timeout",
    "Sign-in was not completed in the browser in time. Run grokbot login again.",
  );
}

/** Releases an unread body so 150 polls never pin 150 sockets. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
