import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

export interface Awaiting {
  readonly reason: string;
}

/**
 * A step the bot asked the owner to do on its own computer (live.boxHandoffRequestId and
 * boxHandoffInstruction). The bot resumes once the owner ends it in the app.
 */
export interface BoxHandoff {
  readonly requestId: string;
  readonly instruction: string;
}

/**
 * How the server ended a run (live.lastTurnSettlement.outcome). An outcome this client
 * does not know is kept as `unknown` and carries no verdict.
 */
export type SettlementOutcome = "success" | "error" | "cancelled" | "unknown";

/**
 * The server's record of the bot's last settled run (live.lastTurnSettlement). `turnId`
 * is the `requestId` of every row of that run. The server clears it when the next run
 * starts, so a wait that needs it must remember it (see WaitSession).
 */
export interface TurnSettlement {
  readonly turnId: string;
  readonly outcome: SettlementOutcome;
  readonly settledAtMs: number;
  /** The `messageId` of the send this settles, when the server names it. */
  readonly clientNonce?: string;
  readonly errorCode?: string;
  readonly errorDomain?: string;
  readonly errorRetryable?: boolean;
}

/** Live run state of one bot. Proto3 omits false, so a missing field means false. */
export interface LiveStatus {
  readonly isRunning: boolean;
  readonly isComposing: boolean;
  readonly isRetrying: boolean;
  readonly awaiting: Awaiting | null;
  readonly hasRunningSubagents: boolean;
  readonly activityTool: string | undefined;
  readonly boxHandoff: BoxHandoff | null;
  /** Absent while a run is in progress and on servers that do not report it. */
  readonly lastTurnSettlement?: TurnSettlement;
}

export const IDLE_STATUS: LiveStatus = Object.freeze({
  isRunning: false,
  isComposing: false,
  isRetrying: false,
  awaiting: null,
  hasRunningSubagents: false,
  activityTool: undefined,
  boxHandoff: null,
});

/** True while the bot is still working its turn. Awaiting alone is not activity. */
export function isActive(status: LiveStatus): boolean {
  return (
    status.isRunning ||
    status.isComposing ||
    status.isRetrying ||
    status.hasRunningSubagents
  );
}

function parseAwaiting(value: unknown): Awaiting | null {
  if (typeof value === "string") return value === "" ? null : { reason: value };
  const o = asJsonObject(value);
  return o ? { reason: readString(o, "reason") ?? "" } : null;
}

function parseBoxHandoff(o: JsonObject): BoxHandoff | null {
  const requestId = readString(o, "boxHandoffRequestId");
  if (!requestId) return null;
  return {
    requestId,
    instruction: readString(o, "boxHandoffInstruction") ?? "",
  };
}

/** A non-negative integer, or a proto int64 sent as a digit string. */
function readInt64(value: unknown): number | undefined {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0
    ? n
    : undefined;
}

function parseOutcome(value: unknown): SettlementOutcome {
  return value === "success" || value === "error" || value === "cancelled"
    ? value
    : "unknown";
}

/** Undefined when `value` is absent or has no readable turnId and settledAtMs. Never throws. */
function parseSettlement(value: unknown): TurnSettlement | undefined {
  const o = asJsonObject(value);
  if (!o) return undefined;
  const turnId = readString(o, "turnId");
  const settledAtMs = readInt64(o.settledAtMs);
  if (!turnId || settledAtMs === undefined) return undefined;
  const clientNonce = readString(o, "clientNonce") || undefined;
  const errorCode = readString(o, "errorCode") || undefined;
  const errorDomain = readString(o, "errorDomain") || undefined;
  return {
    turnId,
    outcome: parseOutcome(o.outcome),
    settledAtMs,
    ...(clientNonce !== undefined && { clientNonce }),
    ...(errorCode !== undefined && { errorCode }),
    ...(errorDomain !== undefined && { errorDomain }),
    ...(typeof o.errorRetryable === "boolean" && {
      errorRetryable: o.errorRetryable,
    }),
  };
}

/** Parses a `live` object from ListGrokBotAgentStatuses or an agentState frame. */
export function parseLiveStatus(
  live: unknown,
  topLevelRunning = false,
): LiveStatus {
  const o: JsonObject = asJsonObject(live) ?? {};
  const activity = asJsonObject(o.activity);
  const lastTurnSettlement = parseSettlement(o.lastTurnSettlement);
  return {
    isRunning: o.isRunning === true || topLevelRunning,
    isComposing: o.isComposingMessage === true,
    isRetrying: o.isRetrying === true,
    awaiting: parseAwaiting(o.awaiting),
    hasRunningSubagents: o.hasRunningSubagents === true,
    activityTool: activity ? readString(activity, "tool") : undefined,
    boxHandoff: parseBoxHandoff(o),
    ...(lastTurnSettlement && { lastTurnSettlement }),
  };
}

/** Parses ListGrokBotAgentStatuses into a map of agentId to LiveStatus. */
export function parseAgentStatusesResponse(
  raw: unknown,
): Map<string, LiveStatus> {
  const o = asJsonObject(raw);
  if (!o)
    throw new GrokBotError(
      "protocol",
      "ListGrokBotAgentStatuses: not an object",
    );
  const out = new Map<string, LiveStatus>();
  for (const item of Array.isArray(o.statuses) ? o.statuses : []) {
    const s = asJsonObject(item);
    const agentId = s ? readString(s, "agentId") : undefined;
    if (!s || !agentId) continue;
    out.set(agentId, parseLiveStatus(s.live, s.isRunning === true));
  }
  return out;
}

interface AgentStatePayload {
  readonly snapshot: boolean;
  readonly statuses: Map<string, LiveStatus>;
}

/** Parses the `agentState` payload of a WatchGrokBotTranscripts frame. */
export function parseAgentStatePayload(raw: unknown): AgentStatePayload {
  const o: JsonObject = asJsonObject(raw) ?? {};
  const live = Array.isArray(o.live)
    ? o.live
    : o.live === undefined
      ? []
      : [o.live];
  const statuses = new Map<string, LiveStatus>();
  for (const item of live) {
    const s = asJsonObject(item);
    const agentId = s ? readString(s, "agentId") : undefined;
    if (s && agentId) statuses.set(agentId, parseLiveStatus(s));
  }
  return { snapshot: o.snapshot === true, statuses };
}
