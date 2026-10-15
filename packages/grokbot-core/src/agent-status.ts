import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

export interface Awaiting {
  readonly reason: string;
}

/** Live run state of one bot. Proto3 omits false, so a missing field means false. */
export interface LiveStatus {
  readonly isRunning: boolean;
  readonly isComposing: boolean;
  readonly isRetrying: boolean;
  readonly awaiting: Awaiting | null;
  readonly hasRunningSubagents: boolean;
  readonly activityTool: string | undefined;
}

export const IDLE_STATUS: LiveStatus = Object.freeze({
  isRunning: false,
  isComposing: false,
  isRetrying: false,
  awaiting: null,
  hasRunningSubagents: false,
  activityTool: undefined,
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

/** Parses a `live` object from ListGrokBotAgentStatuses or an agentState frame. */
export function parseLiveStatus(
  live: unknown,
  topLevelRunning = false,
): LiveStatus {
  const o: JsonObject = asJsonObject(live) ?? {};
  const activity = asJsonObject(o.activity);
  return {
    isRunning: o.isRunning === true || topLevelRunning,
    isComposing: o.isComposingMessage === true,
    isRetrying: o.isRetrying === true,
    awaiting: parseAwaiting(o.awaiting),
    hasRunningSubagents: o.hasRunningSubagents === true,
    activityTool: activity ? readString(activity, "tool") : undefined,
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

export interface AgentStatePayload {
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
