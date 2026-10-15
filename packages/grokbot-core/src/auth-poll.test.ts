import { describe, expect, it } from "vitest";
import { pollLoginResult } from "./auth-poll.js";
import { GrokBotError } from "./contracts.js";

const PAIR = { uuid: "u-1", verifier: "secret-verifier" };
const TOKENS = { accessToken: "acc.tok.sig", refreshToken: "ref.tok.sig" };

function fakeFetch(responses: readonly (number | "throw")[]) {
  const urls: string[] = [];
  let i = 0;
  const fetch = async (url: string) => {
    urls.push(url);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next === "throw") throw new TypeError("fetch failed");
    return next === 200
      ? new Response(JSON.stringify(TOKENS), { status: 200 })
      : new Response("{}", { status: next });
  };
  return { fetch, urls };
}

/** Records each backoff instead of sleeping. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("pollLoginResult", () => {
  it("waits through 404s, then returns the token pair", async () => {
    const { fetch, urls } = fakeFetch([404, 404, 200]);
    const { sleep, delays } = fakeSleep();
    const result = await pollLoginResult(PAIR, {
      apiUrl: "https://api2.cursor.sh",
      fetch,
      sleep,
    });
    expect(result).toStrictEqual(TOKENS);
    expect(urls[0]).toBe(
      "https://api2.cursor.sh/auth/poll?uuid=u-1&verifier=secret-verifier",
    );
    expect(urls).toHaveLength(3);
    expect(delays).toStrictEqual([1000, 1200]);
  });

  it("backs off 1 s × 1.2 per attempt, capped at 10 s", async () => {
    const { fetch } = fakeFetch([...Array(20).fill(404), 200]);
    const { sleep, delays } = fakeSleep();
    await pollLoginResult(PAIR, { fetch, sleep });
    expect(delays.slice(0, 3)).toStrictEqual([1000, 1200, 1440]);
    expect(Math.max(...delays)).toBe(10_000);
  });

  it("times out after 150 attempts with no result", async () => {
    const { fetch, urls } = fakeFetch([404]);
    const { sleep } = fakeSleep();
    await expect(pollLoginResult(PAIR, { fetch, sleep })).rejects.toEqual(
      new GrokBotError(
        "timeout",
        "Sign-in was not completed in the browser in time. Run grokbot login again.",
      ),
    );
    expect(urls).toHaveLength(150);
  });

  it("gives up after three non-404 failures in a row", async () => {
    const { fetch, urls } = fakeFetch([500, "throw", 502]);
    const { sleep } = fakeSleep();
    await expect(pollLoginResult(PAIR, { fetch, sleep })).rejects.toEqual(
      new GrokBotError(
        "http",
        "Sign-in polling failed 3 times in a row (last: HTTP 502).",
      ),
    );
    expect(urls).toHaveLength(3);
  });

  it("resets the failure streak after a 404", async () => {
    const { fetch } = fakeFetch([500, 500, 404, 500, 500, 200]);
    const { sleep } = fakeSleep();
    await expect(pollLoginResult(PAIR, { fetch, sleep })).resolves.toEqual(
      TOKENS,
    );
  });

  it("reports a device sign-in policy refusal as an auth error", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ error: "sign_in_policy_violation" }), {
        status: 403,
      });
    await expect(
      pollLoginResult(PAIR, { fetch, sleep: fakeSleep().sleep }),
    ).rejects.toEqual(
      new GrokBotError(
        "auth",
        "Sign-in on this device is blocked by your organization's device policy.",
      ),
    );
  });

  it("rejects a 200 without both tokens", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ accessToken: "only" }), { status: 200 });
    await expect(
      pollLoginResult(PAIR, { fetch, sleep: fakeSleep().sleep }),
    ).rejects.toEqual(
      new GrokBotError(
        "protocol",
        "Sign-in finished but the server returned no token pair.",
      ),
    );
  });

  it("stops polling when aborted", async () => {
    const controller = new AbortController();
    const { fetch, urls } = fakeFetch([404]);
    const sleep = async () => {
      controller.abort();
    };
    const error = await pollLoginResult(PAIR, {
      fetch,
      sleep,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(controller.signal.aborted).toBe(true);
    expect(error).toBe(controller.signal.reason);
    expect(urls).toHaveLength(1);
  });

  it("never leaks the verifier or tokens in an error", async () => {
    const { fetch } = fakeFetch([500, 500, 500]);
    const error = await pollLoginResult(PAIR, {
      fetch,
      sleep: fakeSleep().sleep,
    }).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(PAIR.verifier);
  });
});
