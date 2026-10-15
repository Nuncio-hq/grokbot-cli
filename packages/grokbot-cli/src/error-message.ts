import { GrokBotError, type GrokBotErrorCode } from "grokbot-core";

const OPEN_APP_HINT =
  "Run grokbot login, or open the Grok Bot app once (logged in), then retry.";

/** Extra stderr line per error code; core messages already name the problem. */
const HINTS: { readonly [C in GrokBotErrorCode]: string | undefined } = {
  auth: OPEN_APP_HINT,
  http: undefined,
  protocol: undefined,
  safety: undefined,
  "not-found": undefined,
  ambiguous: undefined,
  timeout: undefined,
};

/** stderr text for an error a command threw. Core errors carry no secrets by contract. */
export function errorMessage(error: unknown): string {
  if (error instanceof GrokBotError) {
    const hint = HINTS[error.code];
    return `grokbot: ${error.message}\n${hint ? `${hint}\n` : ""}`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `grokbot: unexpected error: ${detail}\n`;
}
