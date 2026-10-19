import { describe, expect, it } from "vitest";
import type { TokenPair } from "./auth-http.js";
import { createTokenSource, TOKEN_REUSE_MS } from "./auth-token-source.js";

const NOW = 1_800_000_000_000;
const jwt = (exp: number, tag = "") =>
  `h.${Buffer.from(JSON.stringify({ exp, tag })).toString("base64url")}.s`;
const FRESH = jwt(NOW / 1000 + 3600, "fresh");
const REFRESHED = jwt(NOW / 1000 + 7200, "refreshed");

function countingApp(token: string) {
  const app = {
    reads: 0,
    read: async () => {
      app.reads++;
      return token;
    },
  };
  return app;
}

const noCliSignIn = {
  load: async () => undefined,
  save: async () => undefined,
  clear: async () => false,
};

describe("createTokenSource: one Keychain read per burst of calls", () => {
  it("reuses a resolved token for later calls inside the reuse window", async () => {
    const app = countingApp(FRESH);
    let clock = NOW;
    const source = createTokenSource({
      store: noCliSignIn,
      readAppToken: app.read,
      now: () => clock,
    });
    expect(await source.getToken()).toBe(FRESH);
    clock += TOKEN_REUSE_MS - 1;
    expect(await source.getToken()).toBe(FRESH);
    expect(app.reads).toBe(1);
  });

  it("reads again once the window has passed, so a login or logout shows up", async () => {
    const app = countingApp(FRESH);
    let clock = NOW;
    const source = createTokenSource({
      store: noCliSignIn,
      readAppToken: app.read,
      now: () => clock,
    });
    await source.getToken();
    clock += TOKEN_REUSE_MS;
    await source.getToken();
    expect(app.reads).toBe(2);
  });

  it("never reuses a token without an expiry", async () => {
    const app = countingApp("opaque-token");
    const source = createTokenSource({
      store: noCliSignIn,
      readAppToken: app.read,
      now: () => NOW,
    });
    await source.getToken();
    await source.getToken();
    expect(app.reads).toBe(2);
  });

  it("refreshes a reused CLI token that has entered the refresh window", async () => {
    // Valid for 6 minutes: outside the 5-minute refresh window now, inside it 2 minutes later.
    const sixMinutes = jwt(NOW / 1000 + 360, "six");
    let pair: TokenPair = { accessToken: sixMinutes, refreshToken: "r1" };
    let clock = NOW;
    const source = createTokenSource({
      store: {
        load: async () => pair,
        save: async (next) => {
          pair = next;
        },
        clear: async () => true,
      },
      refresh: async () => ({ accessToken: REFRESHED, refreshToken: "r2" }),
      now: () => clock,
    });
    expect(await source.getToken()).toBe(sixMinutes);
    clock += 30_000;
    expect(await source.getToken()).toBe(sixMinutes);
    clock += 90_000;
    expect(await source.getToken()).toBe(REFRESHED);
  });
});
