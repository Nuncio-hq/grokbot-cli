import { describe, expect, it } from "vitest";
import { SignInEndedError, type TokenPair } from "./auth-http.js";
import { createTokenSource } from "./auth-token-source.js";
import { GrokBotError } from "./contracts.js";

const NOW = 1_800_000_000_000;
const jwt = (exp: number, tag = "") =>
  `h.${Buffer.from(JSON.stringify({ exp, tag })).toString("base64url")}.s`;
const FRESH = jwt(NOW / 1000 + 3600, "fresh");
/** Inside the 5-minute refresh window but still valid for 60 s. */
const NEAR_EXPIRY = jwt(NOW / 1000 + 60, "near");
const EXPIRED = jwt(NOW / 1000 - 60, "expired");
const REFRESHED = jwt(NOW / 1000 + 7200, "refreshed");

function memoryStore(initial?: TokenPair) {
  let pair = initial;
  let failSave = false;
  return {
    get pair() {
      return pair;
    },
    set pair(next: TokenPair | undefined) {
      pair = next;
    },
    failNextSave() {
      failSave = true;
    },
    load: async () => pair,
    save: async (next: TokenPair) => {
      if (failSave) {
        failSave = false;
        throw new GrokBotError(
          "auth",
          "Cannot save the GrokBot sign-in to the Keychain (security exited 51).",
        );
      }
      pair = next;
    },
    clear: async () => {
      const had = pair !== undefined;
      pair = undefined;
      return had;
    },
  };
}

const appToken = async () => "app-token";
const noApp = async (): Promise<string> => {
  throw new GrokBotError("auth", "Cannot read the Grok Bot account file.");
};
const ended = async (): Promise<TokenPair> => {
  throw new SignInEndedError();
};

describe("createTokenSource: who signs the request", () => {
  it("uses the desktop app's token when the CLI has no sign-in (today's behavior)", async () => {
    const source = createTokenSource({
      store: memoryStore(),
      readAppToken: appToken,
    });
    expect(await source.getToken()).toBe("app-token");
    expect(await source.describe()).toStrictEqual({ source: "app" });
  });

  it("prefers the CLI's own fresh sign-in and does not refresh it", async () => {
    let refreshed = 0;
    const source = createTokenSource({
      store: memoryStore({ accessToken: FRESH, refreshToken: "r1" }),
      readAppToken: appToken,
      refresh: async () => {
        refreshed++;
        return { accessToken: REFRESHED, refreshToken: "r2" };
      },
      now: () => NOW,
    });
    expect(await source.getToken()).toBe(FRESH);
    expect(refreshed).toBe(0);
  });

  it("explains how to sign in when neither source has a token", async () => {
    const source = createTokenSource({
      store: memoryStore(),
      readAppToken: noApp,
    });
    await expect(source.getToken()).rejects.toEqual(
      new GrokBotError(
        "auth",
        "Not signed in. Run grokbot login, or open the Grok Bot app and log in. (Cannot read the Grok Bot account file.)",
      ),
    );
  });
});

describe("createTokenSource: refresh", () => {
  it("refreshes a token near expiry and saves the rotated pair", async () => {
    const store = memoryStore({ accessToken: NEAR_EXPIRY, refreshToken: "r1" });
    const seen: string[] = [];
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      refresh: async (refreshToken) => {
        seen.push(refreshToken);
        return { accessToken: REFRESHED, refreshToken: "r2" };
      },
      now: () => NOW,
    });
    expect(await source.getToken()).toBe(REFRESHED);
    expect(seen).toStrictEqual(["r1"]);
    expect(store.pair).toStrictEqual({
      accessToken: REFRESHED,
      refreshToken: "r2",
    });
  });

  it("shares one refresh across concurrent callers", async () => {
    let calls = 0;
    const source = createTokenSource({
      store: memoryStore({ accessToken: NEAR_EXPIRY, refreshToken: "r1" }),
      readAppToken: appToken,
      refresh: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { accessToken: REFRESHED, refreshToken: "r2" };
      },
      now: () => NOW,
    });
    const tokens = await Promise.all([
      source.getToken(),
      source.getToken(),
      source.getToken(),
    ]);
    expect(tokens).toStrictEqual([REFRESHED, REFRESHED, REFRESHED]);
    expect(calls).toBe(1);
  });

  it("still returns the refreshed token when saving it fails, and keeps the old item", async () => {
    const store = memoryStore({ accessToken: NEAR_EXPIRY, refreshToken: "r1" });
    store.failNextSave();
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      refresh: async () => ({ accessToken: REFRESHED, refreshToken: "r2" }),
      now: () => NOW,
    });
    expect(await source.getToken()).toBe(REFRESHED);
    expect(store.pair).toStrictEqual({
      accessToken: NEAR_EXPIRY,
      refreshToken: "r1",
    });
  });
});

describe("createTokenSource: failures never silently switch account or wipe a good sign-in", () => {
  it.each([
    [
      "a 400/403 or WAF block",
      new GrokBotError(
        "http",
        "Refreshing the GrokBot sign-in failed with HTTP 403.",
      ),
    ],
    [
      "a network error",
      new GrokBotError(
        "http",
        "Refreshing the GrokBot sign-in failed on the network.",
      ),
    ],
    [
      "a device-policy block",
      new GrokBotError(
        "auth",
        "Sign-in on this device is blocked by your organization's device policy.",
      ),
    ],
  ])(
    "keeps the saved pair on %s and uses the still-valid token",
    async (_label, error) => {
      const store = memoryStore({
        accessToken: NEAR_EXPIRY,
        refreshToken: "r1",
      });
      const source = createTokenSource({
        store,
        readAppToken: appToken,
        refresh: async () => {
          throw error;
        },
        now: () => NOW,
      });
      expect(await source.getToken()).toBe(NEAR_EXPIRY);
      expect(store.pair).toStrictEqual({
        accessToken: NEAR_EXPIRY,
        refreshToken: "r1",
      });
    },
  );

  it("reports a transient failure once the token has actually expired, keeping the pair", async () => {
    const store = memoryStore({ accessToken: EXPIRED, refreshToken: "r1" });
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      refresh: async () => {
        throw new GrokBotError(
          "http",
          "Refreshing the GrokBot sign-in failed on the network.",
        );
      },
      now: () => NOW,
    });
    await expect(source.getToken()).rejects.toEqual(
      new GrokBotError(
        "http",
        "Refreshing the GrokBot sign-in failed on the network.",
      ),
    );
    expect(store.pair).toStrictEqual({
      accessToken: EXPIRED,
      refreshToken: "r1",
    });
  });

  it("on an ended sign-in, removes it and says so instead of switching to the app's account", async () => {
    const store = memoryStore({ accessToken: NEAR_EXPIRY, refreshToken: "r1" });
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      refresh: ended,
      now: () => NOW,
    });
    await expect(source.getToken()).rejects.toBeInstanceOf(SignInEndedError);
    expect(store.pair).toBeUndefined();
    // The next call, after the owner has seen the message, uses the app as before.
    expect(await source.getToken()).toBe("app-token");
  });

  it("uses a pair another grokbot process just rotated instead of logging out", async () => {
    const store = memoryStore({ accessToken: NEAR_EXPIRY, refreshToken: "r1" });
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      refresh: async () => {
        // Process B rotated r1 -> r2 while we were refreshing with r1.
        store.pair = { accessToken: REFRESHED, refreshToken: "r2" };
        throw new SignInEndedError();
      },
      now: () => NOW,
    });
    expect(await source.getToken()).toBe(REFRESHED);
    expect(store.pair).toStrictEqual({
      accessToken: REFRESHED,
      refreshToken: "r2",
    });
  });
});

describe("createTokenSource: describe", () => {
  it("names the CLI sign-in with its expiry and no token", async () => {
    const source = createTokenSource({
      store: memoryStore({ accessToken: FRESH, refreshToken: "r1" }),
      readAppToken: appToken,
      now: () => NOW,
    });
    const info = await source.describe();
    expect(info).toStrictEqual({ source: "cli", expiresAt: NOW + 3600 * 1000 });
    expect(JSON.stringify(info)).not.toContain(FRESH);
  });

  it("names the Keychain access mode when the store reports it", async () => {
    const store = {
      ...memoryStore({ accessToken: FRESH, refreshToken: "r1" }),
      itemAccess: async () => "silent" as const,
    };
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      now: () => NOW,
    });
    expect(await source.describe()).toStrictEqual({
      source: "cli",
      expiresAt: NOW + 3600 * 1000,
      keychainAccess: "silent",
    });
  });

  it("never reads a prompt-mode token just to describe it (no macOS dialog for whoami)", async () => {
    let reads = 0;
    const base = memoryStore({ accessToken: FRESH, refreshToken: "r1" });
    const store = {
      ...base,
      load: async () => {
        reads++;
        return base.pair;
      },
      itemAccess: async () => "prompt" as const,
    };
    const source = createTokenSource({
      store,
      readAppToken: appToken,
      now: () => NOW,
    });
    expect(await source.describe()).toStrictEqual({
      source: "cli",
      keychainAccess: "prompt",
    });
    expect(reads).toBe(0);
  });

  it("names no sign-in at all", async () => {
    const source = createTokenSource({
      store: memoryStore(),
      readAppToken: noApp,
    });
    expect(await source.describe()).toStrictEqual({ source: "none" });
  });
});
