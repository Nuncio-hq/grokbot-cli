import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { describeProxy, resolveProxy } from "./proxy-config.js";

const HTTPS_TARGET = "https://api2.cursor.sh/aiserver.v1.GrokBotService/X";

function resolved(env: Record<string, string>, target = HTTPS_TARGET) {
  return resolveProxy(target, env);
}

describe("proxy resolution", () => {
  it("is direct when nothing is configured", () => {
    expect(resolved({})).toBeNull();
  });

  it("prefers GROKBOT_HTTPS_PROXY, then HTTPS_PROXY, then https_proxy", () => {
    const all = {
      GROKBOT_HTTPS_PROXY: "http://a.example:1",
      HTTPS_PROXY: "http://b.example:2",
      https_proxy: "http://c.example:3",
    };
    expect(resolved(all)).toMatchObject({
      host: "a.example",
      port: 1,
      source: "GROKBOT_HTTPS_PROXY",
    });
    const { GROKBOT_HTTPS_PROXY: _, ...rest } = all;
    expect(resolved(rest)).toMatchObject({
      host: "b.example",
      source: "HTTPS_PROXY",
    });
    expect(resolved({ https_proxy: all.https_proxy })).toMatchObject({
      host: "c.example",
      source: "https_proxy",
    });
  });

  it("treats an empty variable as unset", () => {
    expect(resolved({ GROKBOT_HTTPS_PROXY: "", HTTPS_PROXY: "" })).toBeNull();
    expect(
      resolved({
        GROKBOT_HTTPS_PROXY: "  ",
        HTTPS_PROXY: "http://b.example:2",
      }),
    ).toMatchObject({ source: "HTTPS_PROXY" });
  });

  it("lets GROKBOT_HTTPS_PROXY=off force direct over the standard variables", () => {
    expect(
      resolved({
        GROKBOT_HTTPS_PROXY: "off",
        HTTPS_PROXY: "http://b.example:2",
      }),
    ).toBeNull();
    expect(
      resolved({
        GROKBOT_HTTPS_PROXY: "OFF",
        https_proxy: "http://b.example:2",
      }),
    ).toBeNull();
  });

  it("defaults the port from the scheme and keeps the scheme", () => {
    expect(resolved({ HTTPS_PROXY: "http://p.example" })).toMatchObject({
      scheme: "http",
      port: 80,
    });
    expect(resolved({ HTTPS_PROXY: "https://p.example" })).toMatchObject({
      scheme: "https",
      port: 443,
    });
  });

  it("strips IPv6 brackets from the proxy host", () => {
    const proxy = resolved({ HTTPS_PROXY: "http://[2001:db8::1]:3128" });
    expect(proxy).toMatchObject({ host: "2001:db8::1", port: 3128 });
    expect(proxy && describeProxy(proxy).url).toBe("http://[2001:db8::1]:3128");
  });

  it("only proxies https targets", () => {
    expect(
      resolved({ HTTPS_PROXY: "http://p.example:1" }, "http://api.example/x"),
    ).toBeNull();
  });

  it("never proxies loopback", () => {
    const env = { HTTPS_PROXY: "http://p.example:1" };
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(resolved(env, `https://${host}:8443/x`)).toBeNull();
    }
    expect(resolved(env, "https://128.0.0.1/x")).not.toBeNull();
  });
});

describe("NO_PROXY", () => {
  const proxy = "http://p.example:1";
  const via = (noProxy: string, target: string, name = "NO_PROXY") =>
    resolved({ HTTPS_PROXY: proxy, [name]: noProxy }, target) !== null;

  it("matches a host and its subdomains, not look-alikes", () => {
    expect(via("cursor.sh", "https://cursor.sh/")).toBe(false);
    expect(via("cursor.sh", "https://api2.cursor.sh/")).toBe(false);
    expect(via("cursor.sh", "https://notcursor.sh/")).toBe(true);
    expect(via("cursor.sh", "https://cursor.sh.evil.example/")).toBe(true);
  });

  it("matches .suffix and *.suffix against subdomains only", () => {
    expect(via(".cursor.sh", "https://api2.cursor.sh/")).toBe(false);
    expect(via(".cursor.sh", "https://cursor.sh/")).toBe(true);
    expect(via("*.cursor.sh", "https://api2.cursor.sh/")).toBe(false);
    expect(via("*.cursor.sh", "https://cursor.sh/")).toBe(true);
  });

  it("matches * for everything", () => {
    expect(via("*", "https://api2.cursor.sh/")).toBe(false);
  });

  it("limits an entry with a port to that port", () => {
    expect(via("api2.cursor.sh:443", "https://api2.cursor.sh/")).toBe(false);
    expect(via("api2.cursor.sh:8443", "https://api2.cursor.sh/")).toBe(true);
    expect(via("api2.cursor.sh:8443", "https://api2.cursor.sh:8443/")).toBe(
      false,
    );
  });

  it("splits on commas and whitespace and ignores case", () => {
    expect(via("a.example, B.EXAMPLE  c.example", "https://b.example/")).toBe(
      false,
    );
    expect(via("a.example,c.example", "https://b.example/")).toBe(true);
    expect(via("CURSOR.SH", "https://API2.Cursor.SH/")).toBe(false);
  });

  it("matches IP literals exactly, bracketed or not", () => {
    expect(via("203.0.113.7", "https://203.0.113.7/")).toBe(false);
    expect(via("203.0.113.7", "https://203.0.113.70/")).toBe(true);
    expect(via("[2001:db8::1]:443", "https://[2001:db8::1]/")).toBe(false);
    expect(via("2001:db8::1", "https://[2001:db8::1]/")).toBe(false);
  });

  it("reads GROKBOT_NO_PROXY first, then NO_PROXY, then no_proxy", () => {
    const target = "https://api2.cursor.sh/";
    const env = (vars: Record<string, string>) =>
      resolved({ HTTPS_PROXY: proxy, ...vars }, target) !== null;
    expect(env({ no_proxy: "cursor.sh" })).toBe(false);
    expect(env({ NO_PROXY: "cursor.sh" })).toBe(false);
    expect(env({ GROKBOT_NO_PROXY: "cursor.sh" })).toBe(false);
    // The grokbot variable wins when it is set.
    expect(env({ GROKBOT_NO_PROXY: "other.example", NO_PROXY: "*" })).toBe(
      true,
    );
    // An empty one does not hide the next.
    expect(env({ GROKBOT_NO_PROXY: "", NO_PROXY: "*" })).toBe(false);
  });
});

describe("proxy URL validation and credentials", () => {
  const failure = (value: string) => {
    try {
      resolved({ GROKBOT_HTTPS_PROXY: value });
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("rejects malformed and non-http(s) proxy URLs with a GrokBotError", () => {
    for (const value of [
      "ftp://user:secret@p.example:21",
      "socks5://user:secret@p.example:1080",
      "p.example:8080",
      "http://",
      "http://user:secret@:80",
      "not a url with secret",
    ]) {
      const error = failure(value);
      expect(error, value).toBeInstanceOf(GrokBotError);
      expect((error as GrokBotError).message).toContain("GROKBOT_HTTPS_PROXY");
    }
  });

  it("never prints the credentials, in errors or in the description", () => {
    for (const value of [
      "ftp://user:secret@p.example:21",
      "http://user:secret@:80",
      "http://user:%ZZsecret@p.example",
    ]) {
      expect((failure(value) as GrokBotError).message).not.toContain("secret");
    }
    const proxy = resolved({
      HTTPS_PROXY: "http://user:secret@p.example:3128",
    });
    expect(proxy).not.toBeNull();
    if (proxy === null) return;
    const shown = describeProxy(proxy);
    expect(shown).toEqual({
      url: "http://p.example:3128",
      source: "HTTPS_PROXY",
    });
    expect(JSON.stringify(shown)).not.toMatch(/user|secret/);
  });

  it("turns percent-encoded credentials into a Basic authorization", () => {
    const proxy = resolved({
      HTTPS_PROXY: "http://us%40er:p%3Ass@p.example:3128",
    });
    expect(proxy?.authorization).toBe(
      `Basic ${Buffer.from("us@er:p:ss").toString("base64")}`,
    );
    expect(
      resolved({ HTTPS_PROXY: "http://p.example:3128" })?.authorization,
    ).toBeUndefined();
  });
});
