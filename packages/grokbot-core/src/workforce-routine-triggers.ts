import { GrokBotError, type JsonObject } from "./contracts.js";
import { readInputFile } from "./workforce-handler-helpers.js";

/** GitHub events a `github` trigger can name (Grok Bot 0.71.2, unchanged in 0.72.0). */
const GITHUB_EVENTS = [
  "pr-opened",
  "pr-pushed",
  "pr-merged",
  "pr-closed",
  "review-requested",
  "review-approved",
  "review-changes-requested",
  "review-commented",
  "pr-comment",
  "inline-review-comment",
  "review-thread-resolved",
  "review-thread-unresolved",
  "issue-assigned",
  "ci-passed",
  "ci-failed",
] as const;

/** The trigger flags `routines-create` and `routines-update` share. */
interface TriggerFlags {
  readonly cron?: string;
  readonly webhook?: boolean;
  readonly email?: string;
  readonly from?: readonly string[];
  readonly "require-auth-pass"?: boolean;
  readonly github?: string;
  readonly events?: readonly string[];
  readonly "ci-branch"?: string;
  readonly pr?: number;
  /** A trigger as JSON text, for the kinds without flags. */
  readonly trigger?: string;
  /** A file holding that JSON (CLI only). */
  readonly "trigger-file"?: string;
}

const bad = (message: string): never => {
  throw new GrokBotError("not-found", message);
};

/**
 * The trigger the flags describe, or undefined when they name none. Exactly one kind
 * may be named, and a kind's own options need that kind.
 */
export async function triggerFromFlags(
  flags: TriggerFlags,
): Promise<JsonObject | undefined> {
  const kinds = [
    flags.cron !== undefined && "--cron",
    flags.webhook === true && "--webhook",
    flags.email !== undefined && "--email",
    flags.github !== undefined && "--github",
    flags.trigger !== undefined && "--trigger",
    flags["trigger-file"] !== undefined && "--trigger-file",
  ].filter((kind) => kind !== false);
  if (kinds.length > 1) bad(`Name one trigger, not ${kinds.join(" and ")}.`);
  const needs = (kind: string, used: boolean, flag: string) => {
    if (used && kinds[0] !== kind) bad(`${flag} goes with ${kind}.`);
  };
  needs("--email", flags.from !== undefined, "--from");
  needs("--email", flags["require-auth-pass"] === true, "--require-auth-pass");
  needs("--github", flags.events !== undefined, "--events");
  needs("--github", flags["ci-branch"] !== undefined, "--ci-branch");
  needs("--github", flags.pr !== undefined, "--pr");

  if (flags.cron !== undefined) {
    const schedule = flags.cron.trim();
    if (schedule === "") bad("--cron needs a schedule.");
    return { type: "cron", schedule };
  }
  if (flags.webhook === true) return { type: "webhook" };
  if (flags.email !== undefined) {
    return checkTrigger({
      type: "email",
      inbox: flags.email.trim(),
      ...(flags.from === undefined ? {} : { from: flags.from }),
      ...(flags["require-auth-pass"] ? { requireAuthPass: true } : {}),
    });
  }
  if (flags.github !== undefined) {
    if (!flags.events?.length) bad("--github needs --events.");
    return checkTrigger({
      type: "github",
      repo: flags.github.trim(),
      events: flags.events,
      ...(flags.pr === undefined ? {} : { pr: flags.pr }),
      ...(flags["ci-branch"] === undefined
        ? {}
        : { ciBranch: flags["ci-branch"].trim() }),
    });
  }
  const file = flags["trigger-file"];
  const text =
    flags.trigger ??
    (file === undefined
      ? undefined
      : await readInputFile(file, "trigger file"));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("The trigger is not valid JSON.");
  }
  return checkTrigger(parsed);
}

type Field =
  | "string"
  | "strings"
  | "number"
  | "boolean"
  | "object"
  | { readonly oneOf: readonly string[] }
  | { readonly listOf: readonly string[] };
/** Fields per trigger type; a `?` suffix marks an optional field. */
const SHAPES: Readonly<Record<string, Readonly<Record<string, Field>>>> = {
  cron: {
    schedule: "string",
    "firesAt?": "string",
    "window?": "object",
    "timing?": { oneOf: ["exact", "flexible"] },
  },
  webhook: {},
  email: { inbox: "string", "from?": "strings", "requireAuthPass?": "boolean" },
  github: {
    repo: "string",
    events: { listOf: GITHUB_EVENTS },
    "pr?": "number",
    "userAllowlist?": "strings",
    "ciBranch?": "string",
  },
  origin: {
    repo: "string",
    events: "strings",
    "pr?": "number",
    "userAllowlist?": "strings",
  },
  slack: { channel: "string", match: "object" },
  microsoftTeams: {
    tenantId: "string",
    teamIds: "strings",
    channelIds: "strings",
    messageContains: "string",
    messageContainsIsRegex: "boolean",
    blockUnauthenticatedTeamsUsers: "boolean",
  },
  linear: { event: "object", projectIds: "strings", teamIds: "strings" },
  sentry: { event: "object", projectIds: "strings" },
  pagerduty: { event: "object", serviceIds: "strings" },
};

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

function fits(value: unknown, field: Field): boolean {
  if (field === "string") return typeof value === "string" && value !== "";
  if (field === "strings") return isStrings(value);
  if (field === "number") return typeof value === "number";
  if (field === "boolean") return typeof value === "boolean";
  if (field === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if ("oneOf" in field) {
    return typeof value === "string" && field.oneOf.includes(value);
  }
  return (
    isStrings(value) &&
    value.length > 0 &&
    value.every((v) => field.listOf.includes(v))
  );
}

/** Checks a trigger against the shapes the Grok Bot app accepts; returns it unchanged. */
export function checkTrigger(value: unknown, inGroup = false): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("A trigger must be a JSON object with a type.");
  }
  const trigger = value as JsonObject;
  const { type } = trigger;
  if (type === "group" && !inGroup) {
    const { listeners, ...rest } = trigger;
    if (Object.keys(rest).length > 1)
      bad("A group trigger takes only listeners.");
    if (!Array.isArray(listeners) || listeners.length < 2) {
      bad("A group trigger needs at least two listeners.");
    }
    for (const listener of listeners as unknown[]) checkTrigger(listener, true);
    return trigger;
  }
  const shape = typeof type === "string" ? SHAPES[type] : undefined;
  if (shape === undefined) {
    return bad(
      `Unknown trigger type ${JSON.stringify(type)}. Known: ${[...Object.keys(SHAPES), ...(inGroup ? [] : ["group"])].join(", ")}.`,
    );
  }
  const known = new Set(["type"]);
  for (const [key, field] of Object.entries(shape)) {
    const name = key.replace(/\?$/, "");
    known.add(name);
    const optional = key.endsWith("?");
    if (trigger[name] === undefined && optional) continue;
    if (!fits(trigger[name], field)) {
      bad(
        `The ${type} trigger's ${name} is missing or wrong${typeof field === "object" ? ` (one of: ${("oneOf" in field ? field.oneOf : field.listOf).join(", ")})` : ` (expects ${field})`}.`,
      );
    }
  }
  const extra = Object.keys(trigger).filter((key) => !known.has(key));
  if (extra.length > 0) {
    bad(`The ${type} trigger has unknown fields: ${extra.join(", ")}.`);
  }
  return trigger;
}
