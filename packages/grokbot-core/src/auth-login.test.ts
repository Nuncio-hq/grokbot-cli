import { describe, expect, it } from "vitest";
import type { TokenPair } from "./auth-http.js";
import { loginWithApiKey, loginWithBrowser } from "./auth-login.js";
import { GrokBotError } from "./contracts.js";

const PAIR = { accessToken: "acc.tok.sig", refreshToken: "ref.tok.sig" };

function memoryStore() {
  const saved: TokenPair[] = [];
  return {
    saved,
    load: async () => saved.at(-1),
    save: async (pair: TokenPair) => {
      saved.push(pair);
    },
    clear: async () => true,
  };
}

describe("loginWithBrowser", () => {
  it("shows the URL, opens it, polls with the same pair, then saves the tokens", async () => {
    const store = memoryStore();
    const shown: string[] = [];
    const opened: string[] = [];
    let polledWith: { uuid: string; verifier: string } | undefined;
    const result = await loginWithBrowser({
      platform: "darwin",
      store,
      websiteUrl: "https://cursor.com",
      pkce: () => ({ uuid: "U", verifier: "V", challenge: "C" }),
      showUrl: (url) => {
        shown.push(url);
      },
      openUrl: async (url) => {
        opened.push(url);
      },
      poll: async (pair) => {
        polledWith = pair;
        return PAIR;
      },
    });
    const url =
      "https://cursor.com/loginDeepControl?challenge=C&uuid=U&mode=login&redirectTarget=cli";
    expect(shown).toStrictEqual([url]);
    expect(opened).toStrictEqual([url]);
    expect(polledWith).toStrictEqual({ uuid: "U", verifier: "V" });
    expect(store.saved).toStrictEqual([PAIR]);
    expect(result).toStrictEqual({ method: "browser" });
  });

  it("shows the URL before opening, and keeps going when the browser cannot open", async () => {
    const events: string[] = [];
    await loginWithBrowser({
      platform: "darwin",
      store: memoryStore(),
      pkce: () => ({ uuid: "U", verifier: "V", challenge: "C" }),
      showUrl: () => {
        events.push("show");
      },
      openUrl: async () => {
        events.push("open");
        throw new Error("no browser");
      },
      poll: async () => {
        events.push("poll");
        return PAIR;
      },
    });
    expect(events).toStrictEqual(["show", "open", "poll"]);
  });

  it("skips opening a browser when asked (remote/headless machine)", async () => {
    let opened = false;
    await loginWithBrowser({
      platform: "darwin",
      store: memoryStore(),
      openBrowser: false,
      showUrl: () => {},
      openUrl: async () => {
        opened = true;
      },
      poll: async () => PAIR,
    });
    expect(opened).toBe(false);
  });

  it("saves nothing when polling fails", async () => {
    const store = memoryStore();
    await expect(
      loginWithBrowser({
        platform: "darwin",
        store,
        showUrl: () => {},
        openUrl: async () => {},
        poll: async () => {
          throw new GrokBotError(
            "timeout",
            "Sign-in was not completed in the browser in time.",
          );
        },
      }),
    ).rejects.toBeInstanceOf(GrokBotError);
    expect(store.saved).toStrictEqual([]);
  });
});

describe("platform check", () => {
  const NEEDS_MAC = new GrokBotError(
    "auth",
    "grokbot login stores its sign-in in the macOS Keychain, so it needs macOS.",
  );

  it("refuses before showing a URL, so nobody signs in on the web for nothing", async () => {
    let shown = false;
    await expect(
      loginWithBrowser({
        platform: "linux",
        showUrl: () => {
          shown = true;
        },
        openUrl: async () => {},
        poll: async () => PAIR,
      }),
    ).rejects.toEqual(NEEDS_MAC);
    expect(shown).toBe(false);
  });

  it("refuses an API key before sending it anywhere", async () => {
    let sent = false;
    await expect(
      loginWithApiKey("key_1", {
        platform: "linux",
        exchange: async () => {
          sent = true;
          return PAIR;
        },
      }),
    ).rejects.toEqual(NEEDS_MAC);
    expect(sent).toBe(false);
  });
});

describe("loginWithApiKey", () => {
  it("exchanges the key and saves the resulting pair", async () => {
    const store = memoryStore();
    const seen: string[] = [];
    const result = await loginWithApiKey("key_1", {
      platform: "darwin",
      store,
      exchange: async (key) => {
        seen.push(key);
        return PAIR;
      },
    });
    expect(seen).toStrictEqual(["key_1"]);
    expect(store.saved).toStrictEqual([PAIR]);
    expect(result).toStrictEqual({ method: "api-key" });
  });

  it("refuses a blank key before any network call", async () => {
    await expect(
      loginWithApiKey("  ", {
        platform: "darwin",
        store: memoryStore(),
        exchange: async () => {
          throw new Error("must not be called");
        },
      }),
    ).rejects.toEqual(new GrokBotError("auth", "The API key is empty."));
  });
});
