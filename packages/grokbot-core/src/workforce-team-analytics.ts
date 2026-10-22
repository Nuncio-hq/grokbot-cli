import type { JsonObject } from "./contracts.js";
import { asJsonObject } from "./transcript.js";
import {
  fail,
  readAmount,
  readBool,
  readCount,
  readText,
} from "./workforce-team-wire.js";

/** One day of a Team Bot's usage. */
export interface AnalyticsDay {
  /** The server's day label, e.g. `2026-10-20`. */
  readonly day: string;
  readonly activeUsers: number;
  /** People active in the seven days up to this one. */
  readonly trailingSevenDayActiveUsers: number;
  readonly userTurns: number;
  readonly minutesSaved: number;
}

/** A person who used the bot. These are teammates' names and activity. */
export interface AnalyticsUser {
  /** The server's numeric user id. */
  readonly userId: number;
  readonly displayName: string;
  readonly userTurns: number;
  readonly minutesSaved: number;
  /** Someone outside the team. */
  readonly isExternal: boolean;
}

/** What GetGrokBotAgentAnalytics says about one Team Bot. */
export interface AgentAnalytics {
  readonly weeklyActiveUsers: number;
  readonly totalMinutesSaved: number;
  /** Minutes saved before the first listed day. */
  readonly minutesSavedBeforeWindow: number;
  /** The desktop app shows no total while this is false. */
  readonly minutesSavedMeasured: boolean;
  readonly days: readonly AnalyticsDay[];
  readonly topUsers: readonly AnalyticsUser[];
}

function rows(
  body: JsonObject,
  key: string,
  method: string,
): readonly JsonObject[] {
  const list = body[key];
  if (list === undefined) return [];
  if (!Array.isArray(list)) return fail(method, `${key} is not a list`);
  return list.map((row, i) => {
    const object = asJsonObject(row);
    return object ?? fail(method, `${key}[${i}] is not an object`);
  });
}

export function parseAgentAnalytics(
  raw: unknown,
  method: string,
): AgentAnalytics {
  const body = asJsonObject(raw);
  if (!body) return fail(method, "the reply is not an object");
  return {
    weeklyActiveUsers: readCount(body, "weeklyActiveUsers", method),
    totalMinutesSaved: readAmount(body, "totalMinutesSaved", method),
    minutesSavedBeforeWindow: readAmount(
      body,
      "minutesSavedBeforeWindow",
      method,
    ),
    minutesSavedMeasured: readBool(body, "minutesSavedMeasured"),
    days: rows(body, "days", method).map((day) => ({
      day: readText(day, "day"),
      activeUsers: readCount(day, "activeUsers", method),
      trailingSevenDayActiveUsers: readCount(
        day,
        "trailingSevenDayActiveUsers",
        method,
      ),
      userTurns: readCount(day, "userTurns", method),
      minutesSaved: readAmount(day, "minutesSaved", method),
    })),
    topUsers: rows(body, "topUsers", method).map((user) => ({
      userId: readCount(user, "userId", method),
      displayName: readText(user, "displayName"),
      userTurns: readCount(user, "userTurns", method),
      minutesSaved: readAmount(user, "minutesSaved", method),
      isExternal: readBool(user, "isExternal"),
    })),
  };
}
