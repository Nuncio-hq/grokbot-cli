import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/** One routine (automation) of a bot, read from ListGrokBotAgentAutomations. */
export interface Routine {
  /** The server id every routine call takes; not the record's name-based id. */
  readonly automationId: string;
  /** The record's own id, which the Box Gateway's routine methods take. */
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  /** Trigger type, e.g. `cron` or `webhook`. */
  readonly trigger: string;
  /** The whole trigger, e.g. `{type: "github", repo, events}`. */
  readonly triggerConfig: JsonObject;
  /** Human schedule text, e.g. `CRON_TZ=Australia/Adelaide 0 9 * * 1`. */
  readonly schedule: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  /** Milliseconds; a re-created routine gets a new one. */
  readonly createdAt: number | null;
}

function fail(method: string, problem: string): never {
  throw new GrokBotError("protocol", `${method}: ${problem}`);
}

function parseRecord(json: string, method: string): JsonObject {
  try {
    const record = asJsonObject(JSON.parse(json));
    if (record) return record;
  } catch {
    // Reported below with the method name.
  }
  return fail(method, "recordJson is not a JSON object");
}

const timeText = (value: unknown): string | null =>
  typeof value === "string" && value !== ""
    ? value
    : typeof value === "number"
      ? new Date(value).toISOString()
      : null;

function parseRoutine(raw: unknown, method: string): Routine {
  const row = asJsonObject(raw);
  const automationId = row && readString(row, "automationId");
  const json = row && readString(row, "recordJson");
  if (!automationId || json === undefined) {
    fail(method, "a routine has no automationId or recordJson");
  }
  const record = parseRecord(json, method);
  const trigger: JsonObject = asJsonObject(record.trigger) ?? {};
  return {
    automationId,
    id: readString(record, "id") ?? "",
    name: readString(record, "name") ?? "",
    prompt: readString(record, "prompt") ?? "",
    trigger: readString(trigger, "type") ?? "",
    triggerConfig: trigger,
    schedule:
      readString(record, "schedule") ??
      readString(trigger, "schedule") ??
      readString(record, "triggerDescription") ??
      "",
    enabled: record.isEnabled === true,
    nextRunAt: timeText(record.nextRunAt),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : null,
  };
}

/** Parses the `automations` list every routine RPC returns. */
export function parseRoutines(
  raw: unknown,
  method: string,
): readonly Routine[] {
  const rows = asJsonObject(raw)?.automations ?? [];
  if (!Array.isArray(rows)) fail(method, "automations is not a list");
  return rows.map((row) => parseRoutine(row, method));
}

/** By exact automationId, then record id, then name (case-insensitive). */
export function findRoutine(
  routines: readonly Routine[],
  query: string,
): Routine {
  const q = query.trim();
  const byId =
    routines.find((r) => r.automationId === q) ??
    routines.find((r) => r.id !== "" && r.id === q);
  if (byId) return byId;
  const hits = routines.filter(
    (r) => r.name.trim().toLowerCase() === q.toLowerCase(),
  );
  const [only] = hits;
  if (only && hits.length === 1) return only;
  if (hits.length > 1) {
    throw new GrokBotError(
      "ambiguous",
      `${hits.length} routines are named "${q}": ${hits.map((r) => r.automationId).join(", ")}. Pass the automationId.`,
    );
  }
  throw new GrokBotError(
    "not-found",
    `No routine "${q}". List them with grokbot routines-list.`,
  );
}

/** A webhook trigger, alone or inside a group, as the app checks before it mints a key. */
export function isWebhookRoutine(routine: Routine): boolean {
  const { type, listeners } = routine.triggerConfig;
  return (
    type === "webhook" ||
    (type === "group" &&
      Array.isArray(listeners) &&
      listeners.some((l) => asJsonObject(l)?.type === "webhook"))
  );
}
