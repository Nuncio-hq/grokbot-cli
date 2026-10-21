import {
  COMMANDS,
  type CommandInput,
  type CommandName,
} from "./command-catalog.js";
import type {
  CommandSpec,
  ParamSpec,
  ParamTable,
  ParamValue,
} from "./command-spec.js";
import type { JsonObject } from "./contracts.js";

export type ParseResult<N extends CommandName> =
  | { readonly ok: true; readonly input: CommandInput<N> }
  | { readonly ok: false; readonly errors: readonly string[] };

type ParsedParams =
  | { readonly ok: true; readonly input: Readonly<Record<string, ParamValue>> }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface CommandJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonObject>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/** A blank string, or an empty list for a string-list param, counts as absent. */
const isAbsent = (spec: ParamSpec, raw: unknown) =>
  raw === undefined ||
  (typeof raw === "string" && !raw.trim()) ||
  (spec.type === "string-list" && Array.isArray(raw) && raw.length === 0);

const isStringList = (raw: unknown): raw is readonly string[] =>
  Array.isArray(raw) &&
  raw.every((item) => typeof item === "string" && item.trim() !== "");

/** Numeric strings become integers so raw argv values parse directly. */
function parseValue(
  spec: ParamSpec,
  raw: unknown,
): { readonly value: ParamValue } | { readonly mustBe: string } {
  switch (spec.type) {
    case "string":
      return typeof raw === "string" ? { value: raw } : { mustBe: "a string" };
    case "boolean":
      return typeof raw === "boolean"
        ? { value: raw }
        : { mustBe: "a boolean" };
    case "integer": {
      const n =
        typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isSafeInteger(n)) {
        return { mustBe: "an integer" };
      }
      const min = spec.minimum ?? Number.MIN_SAFE_INTEGER;
      return n >= min ? { value: n } : { mustBe: `at least ${min}` };
    }
    case "string-list":
      return isStringList(raw)
        ? { value: raw }
        : { mustBe: "a list of non-blank strings" };
  }
}

/** Validates raw CLI or MCP arguments against one param table; `label` prefixes each error. */
export function parseParams(
  label: string,
  params: ParamTable,
  raw: Readonly<Record<string, unknown>>,
): ParsedParams {
  const entries = Object.entries(params);
  const known = entries.map(([key]) => key);
  const errors = Object.keys(raw)
    .filter((key) => !known.includes(key))
    .map(
      (key) =>
        `${label}: unknown parameter "${key}" (expected one of: ${known.join(", ")})`,
    );
  const input: Record<string, ParamValue> = {};
  for (const [key, spec] of entries) {
    const value = raw[key];
    if (isAbsent(spec, value)) {
      if (spec.required) {
        errors.push(`${label}: missing required parameter "${key}"`);
      } else if (spec.default !== undefined) {
        input[key] = spec.default;
      }
      continue;
    }
    const parsed = parseValue(spec, value);
    if ("value" in parsed) input[key] = parsed.value;
    else {
      errors.push(
        `${label}: parameter "${key}" must be ${parsed.mustBe}, got ${JSON.stringify(value)}`,
      );
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, input };
}

/** Validates raw CLI or MCP arguments for a catalog command. A blank string counts as absent. */
export function parseCommandInput<N extends CommandName>(
  name: N,
  raw: Readonly<Record<string, unknown>>,
): ParseResult<N> {
  const spec: CommandSpec = COMMANDS[name];
  const parsed = parseParams(name, spec.params, raw);
  if (!parsed.ok) return parsed;
  // Each key was checked against the catalog entry CommandInput<N> derives from.
  return { ok: true, input: parsed.input as CommandInput<N> };
}

const valueSchema = (spec: ParamSpec): JsonObject =>
  spec.type === "string-list"
    ? { type: "array", items: { type: "string" } }
    : { type: spec.type };

/** JSON Schema of one param table. `required` is omitted when empty (draft-04 forbids []). */
export function paramsJsonSchema(params: ParamTable): CommandJsonSchema {
  const entries = Object.entries(params);
  const required = entries.filter(([, s]) => s.required).map(([key]) => key);
  const property = (spec: ParamSpec): JsonObject => ({
    ...valueSchema(spec),
    description: spec.description,
    ...(spec.default !== undefined && { default: spec.default }),
    ...(spec.type === "integer" &&
      spec.minimum !== undefined && { minimum: spec.minimum }),
  });
  return {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([key, s]) => [key, property(s)]),
    ),
    ...(required.length > 0 && { required }),
    additionalProperties: false,
  };
}

/** MCP tool `inputSchema` of a catalog command. */
export function commandJsonSchema(name: CommandName): CommandJsonSchema {
  const spec: CommandSpec = COMMANDS[name];
  return paramsJsonSchema(spec.params);
}
