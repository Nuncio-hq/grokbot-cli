import type { TurnSettlement } from "./agent-status.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject } from "./transcript.js";

const REASON_MAX_CHARS = 200;
const OPAQUE_RUN = /[\w+/=.-]{24,}/g;

/** The turnFailed payload was never seen live, so read it loosely and mask anything token-like. */
function failureReason(raw: JsonObject): string {
  const error = asJsonObject(raw.error);
  const candidates = [
    raw.message,
    error?.message,
    raw.error,
    raw.reason,
    raw.failureCode,
  ];
  const text = candidates.find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return (text ?? "turn failed")
    .replace(/\s+/g, " ")
    .trim()
    .replace(OPAQUE_RUN, (run) =>
      /\d/.test(run) && /[a-z]/i.test(run) ? "[redacted]" : run,
    )
    .slice(0, REASON_MAX_CHARS);
}

/**
 * The payload turnFailedError reads for a turn the server settled with an error or a
 * cancellation: the error code and domain it reported, or `cancelled`.
 */
export function settlementFailure(settlement: TurnSettlement): JsonObject {
  if (settlement.outcome === "cancelled") return { message: "cancelled" };
  const { errorCode, errorDomain } = settlement;
  const parts = ["error", errorCode, errorDomain && `(${errorDomain})`];
  return { message: parts.filter(Boolean).join(" ") };
}

export function turnFailedError(
  agentId: string,
  raw: JsonObject,
): GrokBotError {
  return new GrokBotError(
    "protocol",
    `agent ${agentId} failed its turn: ${failureReason(raw)}`,
  );
}
