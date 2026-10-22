import { GrokBotError, type JsonObject } from "./contracts.js";

/** Readers for the proto3 JSON of the Team Bot commands. A missing field is the type's zero. */

export function fail(method: string, problem: string): never {
  throw new GrokBotError("protocol", `${method}: ${problem}`);
}

/** The error for a flag value outside its choices. */
export function badChoice(
  flag: string,
  choices: readonly string[],
  value: string,
) {
  return new GrokBotError(
    "safety",
    `--${flag} must be one of ${choices.join(", ")}, not ${JSON.stringify(value)}.`,
  );
}

/** An int32 or int64 count: a number or a digit string; omitted reads as 0. */
export function readCount(row: JsonObject, key: string, method: string) {
  const value = row[key];
  if (value === undefined || value === null || value === "") return 0;
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
  return fail(method, `${key} is not a non-negative integer`);
}

/** A double: a number or a numeric string; omitted reads as 0. */
export function readAmount(row: JsonObject, key: string, method: string) {
  const value = row[key];
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n === "number" && Number.isFinite(n)) return n;
  return fail(method, `${key} is not a number`);
}

/** An int64 id such as a user id, kept as the digit string; null when omitted or 0. */
export function readInt64Id(
  row: JsonObject,
  key: string,
  method: string,
): string | null {
  const value = row[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const id = BigInt(value).toString();
    return id === "0" ? null : id;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value === 0 ? null : String(value);
  }
  return fail(method, `${key} is not an integer id`);
}

/** An int64 epoch-milliseconds field as an ISO time; null when omitted or 0. */
export function readTime(
  row: JsonObject,
  key: string,
  method: string,
): string | null {
  const ms = readInt64Id(row, key, method);
  if (ms === null) return null;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) {
    return fail(method, `${key} is not a time`);
  }
  return date.toISOString();
}

/** A string field; omitted reads as "". */
export function readText(row: JsonObject, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export function readBool(row: JsonObject, key: string): boolean {
  return row[key] === true;
}
