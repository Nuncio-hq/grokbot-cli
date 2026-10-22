import type { JsonObject } from "./contracts.js";
import { asJsonObject } from "./transcript.js";
import {
  badChoice,
  fail,
  readInt64Id,
  readText,
  readTime,
} from "./workforce-team-wire.js";

/**
 * A Team Bot's review queue (0.75.0): changes to the team's shared memory and skills that
 * someone proposed and an owner or manager approves or rejects.
 */

const STATUS_WIRE = {
  pending: "GROK_BOT_TEAM_REVIEW_ITEM_STATUS_PENDING",
  approved: "GROK_BOT_TEAM_REVIEW_ITEM_STATUS_APPROVED",
  rejected: "GROK_BOT_TEAM_REVIEW_ITEM_STATUS_REJECTED",
} as const;
export const DECISION_WIRE = {
  approve: "GROK_BOT_TEAM_REVIEW_DECISION_APPROVE",
  reject: "GROK_BOT_TEAM_REVIEW_DECISION_REJECT",
} as const;
const MEMORY_ACTIONS = {
  GROK_BOT_TEAM_REVIEW_MEMORY_ACTION_WRITE: "write",
  GROK_BOT_TEAM_REVIEW_MEMORY_ACTION_FORGET: "forget",
} as const;
const SKILL_ACTIONS = {
  GROK_BOT_TEAM_REVIEW_SKILL_ACTION_ADD: "add",
  GROK_BOT_TEAM_REVIEW_SKILL_ACTION_UPDATE: "update",
  GROK_BOT_TEAM_REVIEW_SKILL_ACTION_REMOVE: "remove",
} as const;

export type ReviewStatus = keyof typeof STATUS_WIRE;
export type ReviewDecision = keyof typeof DECISION_WIRE;
type MemoryAction = (typeof MEMORY_ACTIONS)[keyof typeof MEMORY_ACTIONS];
type SkillAction = (typeof SKILL_ACTIONS)[keyof typeof SKILL_ACTIONS];

const FILTERS = ["pending", "approved", "rejected", "all"] as const;
export type ReviewFilter = (typeof FILTERS)[number];

/** What a review item would change. */
export type ReviewChange =
  | {
      readonly kind: "memory";
      readonly action: MemoryAction;
      readonly memoryType: string;
      readonly text: string;
    }
  | {
      readonly kind: "skill";
      readonly action: SkillAction;
      readonly name: string;
      readonly description: string;
      /** The proposed SKILL.md text. */
      readonly content: string;
    }
  | {
      readonly kind: "folder-memory";
      readonly action: MemoryAction;
      readonly memoryType: string;
      readonly path: string;
      readonly text: string;
      readonly metaJson: string;
    }
  /** No change, or one this grokbot does not know. */
  | { readonly kind: "unknown" };

export interface ReviewItem {
  readonly itemId: string;
  /** `unknown` when the server sent no status or one this grokbot does not know. */
  readonly status: ReviewStatus | "unknown";
  /** Who proposed it: the server's numeric user id, kept as a string. */
  readonly proposedByUserId: string | null;
  readonly reviewedByUserId: string | null;
  /** ISO times. */
  readonly createdAt: string | null;
  readonly reviewedAt: string | null;
  readonly change: ReviewChange;
  readonly method: string;
  readonly summary: string;
}

/** The `--status` value; matched without regard to case. */
export function parseReviewFilter(value: string): ReviewFilter {
  const wanted = value.trim().toLowerCase();
  const filter = FILTERS.find((f) => f === wanted);
  if (filter) return filter;
  throw badChoice("status", FILTERS, value);
}

/** The statuses `ListGrokBotTeamReviewItems` is asked for. */
export function wireStatuses(filter: ReviewFilter): readonly string[] {
  return filter === "all" ? Object.values(STATUS_WIRE) : [STATUS_WIRE[filter]];
}

/** The `--decision` value; matched without regard to case. */
export function parseReviewDecision(value: string): ReviewDecision {
  const wanted = value.trim().toLowerCase();
  const decision = (Object.keys(DECISION_WIRE) as ReviewDecision[]).find(
    (d) => d === wanted,
  );
  if (decision) return decision;
  throw badChoice("decision", Object.keys(DECISION_WIRE), value);
}

function lookup<V>(table: Readonly<Record<string, V>>, wire: unknown) {
  return typeof wire === "string" && Object.hasOwn(table, wire)
    ? table[wire]
    : undefined;
}

function parseChange(raw: unknown): ReviewChange {
  const change = asJsonObject(raw) ?? {};
  const memory = asJsonObject(change.memory);
  const skill = asJsonObject(change.skill);
  const folder = asJsonObject(change.folderMemory);
  if (memory) {
    const action = lookup(MEMORY_ACTIONS, memory.action);
    return action
      ? {
          kind: "memory",
          action,
          memoryType: readText(memory, "memoryType"),
          text: readText(memory, "text"),
        }
      : { kind: "unknown" };
  }
  if (skill) {
    const action = lookup(SKILL_ACTIONS, skill.action);
    return action
      ? {
          kind: "skill",
          action,
          name: readText(skill, "name"),
          description: readText(skill, "description"),
          content: readText(skill, "content"),
        }
      : { kind: "unknown" };
  }
  if (folder) {
    const action = lookup(MEMORY_ACTIONS, folder.action);
    return action
      ? {
          kind: "folder-memory",
          action,
          memoryType: readText(folder, "memoryType"),
          path: readText(folder, "path"),
          text: readText(folder, "text"),
          metaJson: readText(folder, "metaJson"),
        }
      : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function parseStatus(wire: unknown): ReviewItem["status"] {
  const found = (Object.keys(STATUS_WIRE) as ReviewStatus[]).find(
    (status) => STATUS_WIRE[status] === wire,
  );
  return found ?? "unknown";
}

/**
 * One review item. `itemId` is what every later call takes, so an item without one is a
 * contract break, unless the caller already knows it (`knownId`, for a resolve reply).
 */
function parseItem(
  raw: unknown,
  method: string,
  where: string,
  knownId?: string,
): ReviewItem {
  const row = asJsonObject(raw);
  if (!row) return fail(method, `${where} is not an object`);
  const itemId = readText(row, "itemId") || knownId;
  if (!itemId) return fail(method, `${where} has no itemId`);
  const change: JsonObject = asJsonObject(row.change) ?? {};
  return {
    itemId,
    status: parseStatus(row.status),
    proposedByUserId: readInt64Id(row, "proposedByUserId", method),
    reviewedByUserId: readInt64Id(row, "reviewedByUserId", method),
    createdAt: readTime(row, "createdAtMs", method),
    reviewedAt: readTime(row, "reviewedAtMs", method),
    change: parseChange(change),
    method: readText(change, "method"),
    summary: readText(change, "summary"),
  };
}

/** The `items` of a ListGrokBotTeamReviewItems reply. */
export function parseReviewItems(
  raw: unknown,
  method: string,
): readonly ReviewItem[] {
  const body = asJsonObject(raw);
  if (!body) return fail(method, "the reply is not an object");
  if (body.items === undefined) return [];
  if (!Array.isArray(body.items)) return fail(method, "items is not a list");
  return body.items.map((item, i) => parseItem(item, method, `items[${i}]`));
}

/**
 * The updated item of a ResolveGrokBotTeamReviewItem reply, or null when the server sent
 * none. The decision is already made by then, so a thin reply is not an error.
 */
export function parseResolvedItem(
  raw: unknown,
  method: string,
  itemId: string,
): ReviewItem | null {
  const item = asJsonObject(raw)?.item;
  return item === undefined ? null : parseItem(item, method, "item", itemId);
}

/** One line of text: runs of whitespace become a space; long text ends in an ellipsis. */
export function clipText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= limit) return flat;
  return `${chars.slice(0, limit - 1).join("")}…`;
}

const quoted = (text: string, limit: number) =>
  text === "" ? "" : `: "${clipText(text, limit)}"`;
const inParens = (text: string) => (text === "" ? "" : ` (${text})`);

/** Default cut for proposed text in human output; `--json` carries all of it. */
export const REVIEW_TEXT_LIMIT = 200;

/**
 * What a change does, in plain words: the first line says it, a skill's proposed content
 * follows on a second. Proposed text is cut to `limit` characters.
 */
export function describeReviewChange(
  change: ReviewChange,
  limit: number = REVIEW_TEXT_LIMIT,
): readonly string[] {
  switch (change.kind) {
    case "memory":
      return [
        `${change.action === "write" ? "Add a memory" : "Forget a memory"}${inParens(change.memoryType)}${quoted(change.text, limit)}`,
      ];
    case "folder-memory":
      return [
        `${change.action === "write" ? "Add to" : "Forget from"} the memory folder ${change.path || "(no path)"}${inParens(change.memoryType)}${quoted(change.text, limit)}`,
      ];
    case "skill": {
      const verb = { add: "Add", update: "Update", remove: "Remove" }[
        change.action
      ];
      const description =
        change.action === "remove" ? "" : quoted(change.description, limit);
      return [
        `${verb} the skill ${change.name || "(no name)"}${description}`,
        ...(change.action !== "remove" && change.content !== ""
          ? [`Content: ${clipText(change.content, limit)}`]
          : []),
      ];
    }
    case "unknown":
      return ["A change this grokbot does not recognise (see --json)."];
  }
}
