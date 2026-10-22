import type { Agent } from "./agents.js";
import { GrokBotError } from "./contracts.js";
import { asJsonObject } from "./transcript.js";

/** "... was rejected with HTTP 403: <body>. If the login is stale, ..." or "... failed with HTTP 404: <body>". */
const REFUSAL =
  /(?:was rejected|failed) with HTTP (403|404)(?:: (.*?))?(?:\. If the login is stale.*)?$/s;

/**
 * The server's own sentence from an error body: the user-facing `detail` of its error
 * details (the live 404 says only `"message":"Error"` beside it), else the JSON `message`,
 * else plain text. A body that says it is an authentication failure has none, so a stale
 * login keeps its login hint.
 */
function sentence(body: string): string | undefined {
  const text = body.trim();
  try {
    const json = asJsonObject(JSON.parse(text));
    if (json) {
      const { code, message, details } = json;
      if (code === "unauthenticated") return undefined;
      const detail = (Array.isArray(details) ? details : [])
        .map(
          (d) =>
            asJsonObject(asJsonObject(asJsonObject(d)?.debug)?.details)?.detail,
        )
        .find((d): d is string => typeof d === "string" && d.trim() !== "");
      if (detail !== undefined) return detail.trim();
      return typeof message === "string" && message.trim() !== ""
        ? message.trim()
        : undefined;
    }
  } catch {
    // Not JSON, or cut off at the length limit: read it as text below.
  }
  const field = (name: string) =>
    new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`)
      .exec(text)?.[1]
      ?.trim();
  const cut = field("detail") || field("message");
  if (cut !== undefined) return cut || undefined;
  return text === "" || text.startsWith("{") ? undefined : text;
}

/**
 * Runs one Team Bot call. When the server refuses with HTTP 403 or 404 and says why,
 * the error names the bot and carries the server's sentence and `hint` (if any), instead of
 * the stale-login advice a 403 normally gets. Anything else passes through unchanged.
 */
export async function explainingRefusal<T>(
  agent: Agent,
  method: string,
  hint: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof GrokBotError)) throw error;
    const [, status, body] = REFUSAL.exec(error.message) ?? [];
    const why = body === undefined ? undefined : sentence(body);
    if (status === undefined || why === undefined) throw error;
    const end = /[.!?]$/.test(why) ? why : `${why}.`;
    throw new GrokBotError(
      status === "404" ? "not-found" : "http",
      `${method} for ${agent.name} was refused with HTTP ${status}: ${hint === "" ? end : `${end} ${hint}`}`,
      { cause: error },
    );
  }
}
