import { describe, expect, it } from "vitest";
import { SignInEndedError } from "./auth-http.js";
import {
  exchangeApiKey,
  needsRefresh,
  refreshTokenPair,
  tokenExpiresAt,
} from "./auth-refresh.js";
import { GrokBotError } from "./contracts.js";

/** An unsigned JWT with the given `exp` (seconds); only the payload is read. */
const jwt = (exp?: number) =>
  `h.${Buffer.from(JSON.stringify(exp === undefined ? {} : { exp })).toString("base64url")}.s`;

const NOW = 1_800_000_000_000;
const PAIR = {
  accessToken: jwt(NOW / 1000 + 3600),
  refreshToken: "ref.old.sig",
};

/** The rejection of a promise expected to fail. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

function recordingFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  };
  return { fetch, calls };
}

describe("tokenExpiresAt / needsRefresh", () => {
  it("reads exp from the JWT payload", () => {
    expect(tokenExpiresAt(jwt(1_800_000_100))).toBe(1_800_000_100_000);
    expect(tokenExpiresAt("not-a-jwt")).toBeUndefined();
  });

  it("refreshes inside the app's 5-minute window, or when exp is unreadable", () => {
    const now = () => NOW;
    expect(needsRefresh(jwt(NOW / 1000 + 301), now)).toBe(false);
    expect(needsRefresh(jwt(NOW / 1000 + 299), now)).toBe(true);
    expect(needsRefresh(jwt(), now)).toBe(true);
    expect(needsRefresh("garbage", now)).toBe(true);
  });
});

describe("refreshTokenPair", () => {
  it("posts the app's refresh_token grant with its client id", async () => {
    const { fetch, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "acc.new.sig",
            refresh_token: "ref.new.sig",
          }),
        ),
    );
    const pair = await refreshTokenPair(PAIR.refreshToken, {
      apiUrl: "https://api2.cursor.sh",
      fetch,
    });
    expect(pair).toStrictEqual({
      accessToken: "acc.new.sig",
      refreshToken: "ref.new.sig",
    });
    expect(calls[0]?.url).toBe("https://api2.cursor.sh/oauth/token");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toStrictEqual({
      client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
      grant_type: "refresh_token",
      refresh_token: "ref.old.sig",
    });
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    const { fetch } = recordingFetch(
      () => new Response(JSON.stringify({ access_token: "acc.new.sig" })),
    );
    expect(await refreshTokenPair("ref.old.sig", { fetch })).toStrictEqual({
      accessToken: "acc.new.sig",
      refreshToken: "ref.old.sig",
    });
  });

  it.each([
    [
      "shouldLogout",
      () => new Response(JSON.stringify({ shouldLogout: true })),
    ],
    ["HTTP 401", () => new Response("bad ref.old.sig", { status: 401 })],
    [
      "OAuth invalid_grant",
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    ],
  ])("ends the sign-in on %s, never echoing the token", async (_l, reply) => {
    const { fetch } = recordingFetch(reply);
    const error = await failureOf(refreshTokenPair("ref.old.sig", { fetch }));
    expect(error).toBeInstanceOf(SignInEndedError);
    expect(error.message).not.toContain("ref.old.sig");
  });

  it.each([
    [400, "{}"],
    [403, "<html>blocked by WAF</html>"],
  ])(
    "treats HTTP %i without invalid_grant as a retryable failure, not a logout",
    async (status, body) => {
      const { fetch } = recordingFetch(() => new Response(body, { status }));
      const error = await failureOf(refreshTokenPair("r", { fetch }));
      expect(error).not.toBeInstanceOf(SignInEndedError);
      expect(error).toEqual(
        new GrokBotError(
          "http",
          `Refreshing the GrokBot sign-in failed with HTTP ${status}.`,
        ),
      );
    },
  );

  it("falls back to the built-in client id when the override is blank", async () => {
    const before = process.env.GROKBOT_AUTH_CLIENT_ID;
    process.env.GROKBOT_AUTH_CLIENT_ID = "   ";
    try {
      const { fetch, calls } = recordingFetch(
        () => new Response(JSON.stringify({ access_token: "a" })),
      );
      await refreshTokenPair("r", { fetch });
      expect(JSON.parse(String(calls[0]?.init.body)).client_id).toBe(
        "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
      );
    } finally {
      if (before === undefined) delete process.env.GROKBOT_AUTH_CLIENT_ID;
      else process.env.GROKBOT_AUTH_CLIENT_ID = before;
    }
  });

  it("times out instead of hanging a long-running host", async () => {
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    await expect(
      refreshTokenPair("r", { fetch, timeoutMs: 20 }),
    ).rejects.toEqual(
      new GrokBotError(
        "http",
        "Refreshing the GrokBot sign-in timed out after 0 s.",
      ),
    );
  });

  it("reports a server error without the body", async () => {
    const { fetch } = recordingFetch(
      () => new Response("oops", { status: 503 }),
    );
    await expect(refreshTokenPair("r", { fetch })).rejects.toEqual(
      new GrokBotError(
        "http",
        "Refreshing the GrokBot sign-in failed with HTTP 503.",
      ),
    );
  });
});

describe("exchangeApiKey", () => {
  it("trades an API key for a token pair with a Bearer POST", async () => {
    const { fetch, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            accessToken: "acc.k.sig",
            refreshToken: "ref.k.sig",
          }),
        ),
    );
    const pair = await exchangeApiKey("key_123", {
      apiUrl: "https://api2.cursor.sh",
      fetch,
    });
    expect(pair).toStrictEqual({
      accessToken: "acc.k.sig",
      refreshToken: "ref.k.sig",
    });
    const [call] = calls;
    if (!call) throw new Error("expected one exchange call");
    expect(call.url).toBe("https://api2.cursor.sh/auth/exchange_user_api_key");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      "Bearer key_123",
    );
  });

  it("never leaks the key when fetch throws synchronously with it in the message", async () => {
    const fetch = (_url: string, init: RequestInit): Promise<Response> => {
      throw new TypeError(
        `Invalid header value: ${(init.headers as Record<string, string>).authorization}`,
      );
    };
    const error = await failureOf(exchangeApiKey("key_secret", { fetch }));
    expect(error).toEqual(
      new GrokBotError("http", "Exchanging the API key failed on the network."),
    );
    expect(error.message).not.toContain("key_secret");
  });

  it("rejects an unknown key without echoing it", async () => {
    const { fetch } = recordingFetch(
      () => new Response("key_123 bad", { status: 401 }),
    );
    const error = await failureOf(exchangeApiKey("key_123", { fetch }));
    expect(error).toEqual(
      new GrokBotError("auth", "The API key was not accepted (HTTP 401)."),
    );
    expect(error.message).not.toContain("key_123");
  });
});
