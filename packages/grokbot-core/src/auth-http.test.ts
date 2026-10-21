import { afterEach, describe, expect, it } from "vitest";
import { apiUrlOf, authFetch, websiteUrlOf } from "./auth-http.js";
import { GrokBotError } from "./contracts.js";
import { ProxyError } from "./proxy-config.js";

const saved = {
  api: process.env.GROKBOT_API_BASE_URL,
  web: process.env.GROKBOT_WEBSITE_URL,
  cursorApi: process.env.CURSOR_API_BASE_URL,
};
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
afterEach(() => {
  restore("GROKBOT_API_BASE_URL", saved.api);
  restore("GROKBOT_WEBSITE_URL", saved.web);
  restore("CURSOR_API_BASE_URL", saved.cursorApi);
});

describe("auth base URLs", () => {
  it("default to Cursor production", () => {
    delete process.env.GROKBOT_API_BASE_URL;
    delete process.env.GROKBOT_WEBSITE_URL;
    expect(apiUrlOf({})).toBe("https://api2.cursor.sh");
    expect(websiteUrlOf({})).toBe("https://cursor.com");
  });

  it("ignore the Cursor app's CURSOR_API_BASE_URL so the refresh token stays on api2", () => {
    delete process.env.GROKBOT_API_BASE_URL;
    process.env.CURSOR_API_BASE_URL = "https://staging.example.com";
    expect(apiUrlOf({})).toBe("https://api2.cursor.sh");
  });

  it("honor a GROKBOT_ override, keeping only the origin", () => {
    process.env.GROKBOT_API_BASE_URL = "https://api.example.com/some/path/";
    expect(apiUrlOf({})).toBe("https://api.example.com");
  });

  it.each(["http://evil.example.com", "javascript:alert(1)", "not a url"])(
    "refuse %s, so a token never leaves over cleartext",
    (raw) => {
      expect(() => apiUrlOf({ apiUrl: raw })).toThrow(
        new GrokBotError(
          "auth",
          "The GrokBot sign-in URL override must be an https:// address.",
        ),
      );
    },
  );

  it("allow plain http only on localhost, for a local test server", () => {
    expect(apiUrlOf({ apiUrl: "http://localhost:4443" })).toBe(
      "http://localhost:4443",
    );
  });
});

describe("authFetch", () => {
  it("rethrows the caller's abort unchanged (Ctrl-C), not a network error", async () => {
    const controller = new AbortController();
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
        controller.abort();
      });
    const error = await authFetch(
      { fetch },
      "https://api2.cursor.sh/x",
      { signal: controller.signal },
      "Testing",
    ).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
  });

  it("keeps a proxy error, which names only the proxy, and still flattens any other failure", async () => {
    const refused = new ProxyError(
      "The proxy 127.0.0.1:3128 refused the tunnel (HTTP 403).",
    );
    const viaProxy = await authFetch(
      { fetch: () => Promise.reject(refused) },
      "https://api2.cursor.sh/x",
      {},
      "Testing",
    ).catch((e: unknown) => e);
    expect(viaProxy).toBe(refused);
    const other = await authFetch(
      { fetch: () => Promise.reject(new Error("token=secret_value")) },
      "https://api2.cursor.sh/x",
      {},
      "Testing",
    ).catch((e: unknown) => e);
    expect((other as GrokBotError).message).toBe(
      "Testing failed on the network.",
    );
  });
});
