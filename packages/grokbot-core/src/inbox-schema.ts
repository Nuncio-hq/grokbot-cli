import { slugify } from "./agents.js";
import {
  INBOX_EXPIRES_IN,
  INBOX_EXPIRY_DAYS,
  INBOX_GENERAL_SLUG,
  INBOX_ID_LENGTH,
  INBOX_SLUG_LENGTH,
  type InboxItem,
  type InboxKind,
  type InboxOutcome,
} from "./inbox-types.js";

export { INBOX_ITEM_JSON_SCHEMA } from "./inbox-json-schema.js";
export { credentialKind } from "./inbox-secrets.js";
export * from "./inbox-types.js";
export {
  type InboxIssue,
  type InboxValidation,
  validateInboxDraft,
  validateInboxText,
  validateInboxUrl,
} from "./inbox-validate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The folder name of a project: `slugify(project)` cut to 60 characters, `_general` when empty. */
export function inboxSlug(project: string): string {
  const slug = slugify(project).slice(0, INBOX_SLUG_LENGTH).replace(/-$/, "");
  return slug === "" ? INBOX_GENERAL_SLUG : slug;
}

/** Whole-second ISO UTC, e.g. `2026-10-20T11:30:00Z`: the form of every stamped time. */
export function inboxTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** `<YYYYMMDDTHHMMSSZ>_<kind>_<id>.json` for an item created at `createdAt`. */
export function inboxFileName(
  createdAt: string,
  kind: InboxKind,
  id: string,
): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d+/, "");
  return `${stamp}_${kind}_${id}.json`;
}

const FILE_NAME = new RegExp(
  `^(\\d{8}T\\d{6}Z)_([a-z]+)_([a-z0-9]{${INBOX_ID_LENGTH}})\\.json$`,
);

/** The parts of an item file name; undefined for any other name. */
export function parseInboxFileName(
  name: string,
):
  | { readonly stamp: string; readonly kind: string; readonly id: string }
  | undefined {
  const match = FILE_NAME.exec(name);
  return match?.[1] && match[2] && match[3]
    ? { stamp: match[1], kind: match[2], id: match[3] }
    : undefined;
}

/** When an item created at `createdMs` expires by default. */
export function inboxExpiresAt(
  createdMs: number,
  kind: InboxKind,
  expiresInMs?: number,
): string {
  return inboxTimestamp(
    createdMs + (expiresInMs ?? INBOX_EXPIRY_DAYS[kind] * DAY_MS),
  );
}

/** Whether an item is past its `expiresAt` at `nowMs`. */
export function isInboxExpired(
  item: Pick<InboxItem, "expiresAt">,
  nowMs: number,
): boolean {
  const at = Date.parse(item.expiresAt);
  return !Number.isNaN(at) && at <= nowMs;
}

const EXPIRES_IN = /^(\d{1,3})([hd])$/;

/** `--expires-in` (`6h`, `3d`) in milliseconds, or the reason it is refused. */
export function parseInboxExpiresIn(
  text: string,
):
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly message: string } {
  const match = EXPIRES_IN.exec(text.trim());
  const ms = match
    ? Number(match[1]) * (match[2] === "d" ? DAY_MS : HOUR_MS)
    : NaN;
  if (
    Number.isNaN(ms) ||
    ms < INBOX_EXPIRES_IN.minHours * HOUR_MS ||
    ms > INBOX_EXPIRES_IN.maxDays * DAY_MS
  )
    return {
      ok: false,
      message: `must be 1h to ${INBOX_EXPIRES_IN.maxDays}d, like 12h or 3d`,
    };
  return { ok: true, ms };
}

/** What an assistant sends back to the bot that left an item. */
export type InboxAction =
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "answer"; readonly choice: string; readonly text?: string }
  | {
      readonly type: "done";
      readonly outcome: InboxOutcome;
      readonly reason?: string;
      readonly ref?: string;
    };

/**
 * The message for `action` on `item`, built here and never by a model:
 * `[inbox <id> · <project> · reply]` then the text, `· answer: <choice>` then optional
 * text, or `· done: <outcome>` then the reason and `Ref: <url>` lines when given. With a
 * `runtime` (the agent runtime's display name, from grokbot's own detection) the bracket
 * ends ` · <runtime>`, with the caller's session `address` ` · <runtime> · <address>`, and
 * with the `job` this message starts (first 8 characters of its id) ` · job <job8>`: the
 * return address a bot copies into `--to-session` and `--re-job`. An address or a job
 * without a runtime is left out.
 */
export function formatInboxMessage(
  item: Pick<InboxItem, "id" | "project">,
  action: InboxAction,
  runtime?: string,
  address?: string,
  job?: string,
): string {
  const head = `[inbox ${item.id} · ${item.project.replace(/\s+/g, " ")} · `;
  const close =
    runtime === undefined
      ? "]"
      : ` · ${runtime}${address === undefined ? "" : ` · ${address}`}${job === undefined ? "" : ` · job ${job}`}]`;
  switch (action.type) {
    case "reply":
      return `${head}reply${close}\n${action.text}`;
    case "answer":
      return [`${head}answer: ${action.choice}${close}`, action.text]
        .filter((line) => line !== undefined && line !== "")
        .join("\n");
    case "done":
      return [
        `${head}done: ${action.outcome}${close}`,
        action.reason,
        action.ref === undefined ? undefined : `Ref: ${action.ref}`,
      ]
        .filter((line) => line !== undefined && line !== "")
        .join("\n");
  }
}
