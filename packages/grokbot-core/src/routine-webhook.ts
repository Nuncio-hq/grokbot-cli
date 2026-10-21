import type { JsonObject } from "./contracts.js";
import { proxyFetch } from "./network-fetch.js";
import { BACKEND_URL, type FetchLike, postText } from "./server-transport.js";

const FIRE_TIMEOUT_MS = 30_000;
const MAX_REPLY_CHARS = 300;

/** Where a webhook routine listens: POST with `Authorization: Bearer <key>`. */
export function webhookUrl(automationId: string): string {
  return new URL(
    `/automations/webhook/${encodeURIComponent(automationId)}`,
    BACKEND_URL,
  ).toString();
}

/** POSTs a JSON body to a routine's webhook. The key never appears in a result or error. */
export type WebhookFirer = (
  url: string,
  key: string,
  body: JsonObject,
  signal?: AbortSignal,
) => Promise<{ readonly status: number; readonly reply: unknown }>;

export function createWebhookFirer(
  fetch: FetchLike = proxyFetch,
): WebhookFirer {
  return async (url, key, body, signal) => {
    const { status, text } = await postText(
      {
        fetch,
        method: "routine webhook",
        url,
        headers: {
          authorization: `Bearer ${key}`,
          "user-agent": "grokbot-core",
        },
        options: { signal, timeoutMs: FIRE_TIMEOUT_MS },
        secrets: [key],
        authHint:
          "The routine's key was refused. The owner can mint a new one with grokbot routines-webhook-key --replace --yes.",
      },
      body,
    );
    const shown = text.replaceAll(key, "[redacted]");
    try {
      return { status, reply: shown === "" ? null : JSON.parse(shown) };
    } catch {
      return { status, reply: shown.slice(0, MAX_REPLY_CHARS) };
    }
  };
}
