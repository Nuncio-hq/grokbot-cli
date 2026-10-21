import type { BoxFile, BoxSnapshot, BoxStore } from "./box-store.js";
import { isInboxExpired } from "./inbox-schema.js";
import {
  INBOX_KINDS,
  INBOX_ROOT,
  INBOX_SEVERITIES,
  type InboxItem,
} from "./inbox-types.js";

/** `<YYYYMMDDTHHMMSSZ>_<kind>_<id>.json`, the name of one item file. */
const ITEM_FILE =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_([a-z-]+)_([a-z0-9]{8})\.json$/;
const SCHEMA = /^grokbot\.inbox\.item\/v(\d+)(?:\.\d+)?$/;
/** The schema major this grokbot reads. */
const SUPPORTED_MAJOR = 1;
/** An item is a few KB; a file past this is not one. */
export const INBOX_ITEM_MAX_BYTES = 256 * 1024;

export const INBOX_ID = /^[a-z0-9]{8}$/;

export type InboxFolder = "open" | "closed";

/** An item file as the cloud computer lists it, before its content is read. */
export interface InboxRef {
  readonly id: string;
  readonly slug: string;
  readonly folder: InboxFolder;
  readonly kind: string;
  /** ISO UTC, from the file name. */
  readonly createdAt: string;
  readonly file: BoxFile;
}

/** Every item file below the inbox root, any project, open or closed. */
export function inboxRefs(snapshot: BoxSnapshot): readonly InboxRef[] {
  const refs: InboxRef[] = [];
  for (const entry of snapshot.list(INBOX_ROOT)) {
    if (entry.kind !== "file") continue;
    const [slug, folder, name, ...deeper] = entry.path
      .slice(INBOX_ROOT.length + 1)
      .split("/");
    if (deeper.length > 0 || slug === undefined || name === undefined) continue;
    if (folder !== "open" && folder !== "closed") continue;
    const match = ITEM_FILE.exec(name);
    if (!match) continue;
    const [, y, mo, d, h, mi, s, kind, id] = match;
    refs.push({
      id: id as string,
      slug,
      folder,
      kind: kind as string,
      createdAt: `${y}-${mo}-${d}T${h}:${mi}:${s}Z`,
      file: entry,
    });
  }
  return refs;
}

export type ReadItem =
  | { readonly state: "ok"; readonly ref: InboxRef; readonly item: InboxItem }
  | {
      readonly state: "needs-newer-grokbot";
      readonly ref: InboxRef;
      readonly schema: string;
    }
  | {
      readonly state: "unreadable";
      readonly ref: InboxRef;
      readonly reason: string;
    }
  | { readonly state: "pending"; readonly ref: InboxRef };

type Obj = Readonly<Record<string, unknown>>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/**
 * What the file must hold for the rest of grokbot to read it without guarding every field:
 * the fields every line and card shows, and the right container type for the others. A bot
 * can write any file into its own folder, so nothing else is taken on trust here; the
 * fields not checked are only ever printed or compared.
 */
function problem(ref: InboxRef, raw: Obj): string | undefined {
  if (raw.id !== ref.id) return "its id is not the one in its file name";
  for (const key of ["project", "title", "createdAt"] as const) {
    if (!isText(raw[key])) return `${key} is missing`;
  }
  if (!(INBOX_KINDS as readonly unknown[]).includes(raw.kind)) {
    return "kind is not a known one";
  }
  if (!(INBOX_SEVERITIES as readonly unknown[]).includes(raw.severity)) {
    return "severity is not a known one";
  }
  if (raw.status !== "open" && raw.status !== "closed") {
    return "status is neither open nor closed";
  }
  if (!isObj(raw.from) || !isText(raw.from.agentId)) {
    return "from.agentId is missing";
  }
  for (const key of [
    "ask",
    "details",
    "work",
    "replyTo",
    "to",
    "closed",
  ] as const) {
    if (raw[key] !== undefined && !isObj(raw[key])) {
      return `${key} is not an object`;
    }
  }
  for (const key of ["files", "refs", "updates", "relatesTo"] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      return `${key} is not a list`;
    }
  }
  const work = raw.work;
  if (isObj(work)) {
    for (const key of ["latest", "next"] as const) {
      if (work[key] !== undefined && !isObj(work[key])) {
        return `work.${key} is not an object`;
      }
    }
  }
  return undefined;
}

export function parseInboxItem(text: string, ref: InboxRef): ReadItem {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: "unreadable", ref, reason: "not valid JSON" };
  }
  if (!isObj(raw)) {
    return { state: "unreadable", ref, reason: "not a JSON object" };
  }
  const schema = typeof raw.schema === "string" ? raw.schema : "";
  const major = SCHEMA.exec(schema)?.[1];
  if (major === undefined) {
    return { state: "unreadable", ref, reason: "no inbox schema" };
  }
  if (Number(major) !== SUPPORTED_MAJOR) {
    return { state: "needs-newer-grokbot", ref, schema };
  }
  const found = problem(ref, raw);
  if (found !== undefined) return { state: "unreadable", ref, reason: found };
  // `problem` checked every field the rest of grokbot relies on.
  return { state: "ok", ref, item: raw as unknown as InboxItem };
}

/** Reads and parses the files, in order. At most 8 downloads at once; blobs are cached for good. */
export async function readInboxItems(
  store: BoxStore,
  refs: readonly InboxRef[],
  signal?: AbortSignal,
): Promise<readonly ReadItem[]> {
  const small = refs.filter((ref) => ref.file.size <= INBOX_ITEM_MAX_BYTES);
  const texts = await store.readTexts(
    small.map((ref) => ref.file),
    { maxBytes: INBOX_ITEM_MAX_BYTES, signal },
  );
  const textOf = new Map(small.map((ref, i) => [ref, texts[i]]));
  return refs.map((ref): ReadItem => {
    if (!textOf.has(ref)) {
      return { state: "unreadable", ref, reason: "larger than an item can be" };
    }
    const text = textOf.get(ref);
    return text === undefined
      ? { state: "pending", ref }
      : parseInboxItem(text, ref);
  });
}

/** The short name `grokbot computers` shows for a machine: before the first dot, lowercase. */
export const shortHost = (label: string): string =>
  (label.split(".")[0] ?? "").trim().toLowerCase();

/**
 * An open item whose `work.next` is for a session at an owner computer whose label is
 * this computer's. A closed item, or a step the bot or the owner takes, is nobody's turn here.
 */
export function isYourTurnHere(item: InboxItem, hostname: string): boolean {
  const next = item.work?.next;
  return (
    item.status === "open" &&
    next?.at === "owner-computer" &&
    next.by === "session" &&
    typeof next.machine?.label === "string" &&
    shortHost(next.machine.label) === hostname
  );
}

/**
 * The session address an item is for (`to.session`), or undefined when it names none. A
 * bot can write any file into its own folder, so only a non-empty string counts.
 */
export function toSessionOf(item: InboxItem): string | undefined {
  const session: unknown = item.to?.session;
  return typeof session === "string" && session.trim() !== ""
    ? session.trim()
    : undefined;
}

/**
 * The job an item answers (`to.job`) as the first 8 characters of its id, lower-case, or
 * undefined when it names none. Same trust as `toSessionOf`: only a hex-and-dash string
 * of 8 to 36 characters counts.
 */
export function toJobOf(item: InboxItem): string | undefined {
  const job: unknown = item.to?.job;
  const handle = typeof job === "string" ? job.trim().toLowerCase() : "";
  return /^[0-9a-f-]{8,36}$/.test(handle) ? handle.slice(0, 8) : undefined;
}

/** Past its `expiresAt`, which the cloud side has not swept into closed/ yet. */
export function isExpired(item: InboxItem, nowMs: number): boolean {
  return item.status === "open" && isInboxExpired(item, nowMs);
}
