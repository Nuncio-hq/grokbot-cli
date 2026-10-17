import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { createWebhookFirer, webhookUrl } from "./routine-webhook.js";

const KEY = "synthetic-webhook-key-91c2";
const URL = webhookUrl("auto 1");

function fakeFetch(response: () => Response) {
  const seen: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body,
    });
    return response();
  };
  return { fetch, seen };
}

describe("webhookUrl", () => {
  it("is the backend's routine webhook path with the id encoded", () => {
    expect(URL).toBe("https://api2.cursor.sh/automations/webhook/auto%201");
  });
});

describe("createWebhookFirer", () => {
  it("POSTs the JSON body with the key as a bearer header", async () => {
    const { fetch, seen } = fakeFetch(
      () => new Response('{"ok":true}', { status: 202 }),
    );
    const out = await createWebhookFirer(fetch)(URL, KEY, { a: 1 });
    expect(out).toEqual({ status: 202, reply: { ok: true } });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.body).toBe('{"a":1}');
  });

  it("returns a text reply cut short, and never echoes the key", async () => {
    const { fetch } = fakeFetch(
      () => new Response(`accepted ${KEY} ${"x".repeat(400)}`),
    );
    const { reply } = await createWebhookFirer(fetch)(URL, KEY, {});
    expect(typeof reply === "string" && reply.length).toBe(300);
    expect(String(reply)).not.toContain(KEY);
    expect(String(reply)).toContain("[redacted]");
  });

  it("maps a refused key to an auth error without the key", async () => {
    const { fetch } = fakeFetch(
      () => new Response(`bad key ${KEY}`, { status: 401 }),
    );
    const error = await createWebhookFirer(fetch)(URL, KEY, {}).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).code).toBe("auth");
    expect((error as GrokBotError).message).not.toContain(KEY);
    expect((error as GrokBotError).message).toContain("routines-webhook-key");
  });
});
