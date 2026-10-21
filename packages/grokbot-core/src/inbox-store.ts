import { randomInt } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type StagedFile, stageInboxFiles } from "./inbox-files.js";
import {
  inboxExpiresAt,
  inboxFileName,
  inboxSlug,
  inboxTimestamp,
  isInboxExpired,
  parseInboxFileName,
} from "./inbox-schema.js";
import {
  INBOX_CLOSED_RETENTION_DAYS,
  INBOX_KINDS,
  INBOX_LIMITS,
  INBOX_OUTCOMES,
  INBOX_ROOT,
  INBOX_ROOT_ENV,
  INBOX_SCHEMA_ID,
  INBOX_SEVERITIES,
  INBOX_WORK_STATES,
  type InboxClosed,
  type InboxDraft,
  type InboxFile,
  type InboxFrom,
  type InboxItem,
  type InboxWorkState,
} from "./inbox-types.js";
import {
  type InboxIssue,
  validateInboxDraft,
  validateInboxText,
  validateInboxUrl,
} from "./inbox-validate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_TRIES = 50;
const EXPIRED_REASON = "Passed its expiry date without being closed.";

/** The inbox root: `GROKBOT_INBOX_ROOT` when set, else `/workspace/.grokbot/inbox`. */
export function inboxRoot(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env[INBOX_ROOT_ENV]?.trim() || INBOX_ROOT;
}

export interface InboxStoreOptions {
  readonly root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Milliseconds since the epoch; injectable so tests move time. */
  readonly now?: () => number;
  /** An 8-character id; injectable so tests know it. */
  readonly randomId?: () => string;
}

export interface InboxExpired {
  readonly id: string;
  readonly project: string;
  readonly title: string;
}

export interface InboxWritten {
  readonly id: string;
  readonly project: string;
  readonly slug: string;
  /** The item's file on this computer. */
  readonly path: string;
  /** Open items in the project after this change. */
  readonly openInProject: number;
  /** Items this run closed as expired. */
  readonly expired: readonly InboxExpired[];
}

export interface InboxPosted extends InboxWritten {
  readonly deduped: boolean;
}

/** Why a request was refused: `invalid` input, an item that does not exist or one already closed. */
export interface InboxFailure {
  readonly ok: false;
  readonly kind: "invalid" | "not-found" | "closed";
  readonly errors: readonly InboxIssue[];
}

export type InboxResult<T> = ({ readonly ok: true } & T) | InboxFailure;

export interface InboxPostRequest {
  /** The draft as the poster wrote it. */
  readonly draft: unknown;
  /** Files to copy into the item's folder. */
  readonly files?: readonly string[];
  readonly from: InboxFrom;
  /** Overrides the expiry of the kind. */
  readonly expiresInMs?: number;
}

export interface InboxUpdateRequest {
  readonly id: string;
  readonly note: string;
  /** The updating run; absent when a person ran the command. */
  readonly run?: string;
  readonly severity?: string;
  readonly state?: string;
}

export interface InboxCloseRequest {
  readonly id: string;
  readonly outcome: string;
  /** An agentId, or "grokbot" when a person ran the command. */
  readonly by: string;
  readonly reason?: string;
  readonly ref?: string;
}

export interface InboxStore {
  readonly root: string;
  post(request: InboxPostRequest): Promise<InboxResult<InboxPosted>>;
  update(request: InboxUpdateRequest): Promise<InboxResult<InboxWritten>>;
  close(request: InboxCloseRequest): Promise<InboxResult<InboxWritten>>;
  /** Expires open items past `expiresAt` and deletes old closed ones. */
  prune(): Promise<readonly InboxExpired[]>;
}

interface Entry {
  readonly slug: string;
  readonly state: "open" | "closed";
  readonly name: string;
  readonly path: string;
  readonly item: InboxItem;
}

type Stamped = Omit<InboxItem, keyof InboxDraft | "schema">;

function isStoredItem(value: unknown): value is InboxItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === INBOX_SCHEMA_ID &&
    "id" in value &&
    typeof value.id === "string" &&
    "project" in value &&
    typeof value.project === "string" &&
    "kind" in value &&
    INBOX_KINDS.some((kind) => kind === value.kind) &&
    "title" in value &&
    typeof value.title === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "string" &&
    "status" in value &&
    (value.status === "open" || value.status === "closed")
  );
}

/** Directory names, or none when the folder is missing. */
async function names(dir: string, dirsOnly: boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && (!dirsOnly || e.isDirectory()))
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

/** Every item file under the root; files that are not valid items are left alone and skipped. */
async function scan(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const slug of await names(root, true)) {
    for (const state of ["open", "closed"] as const) {
      const dir = join(root, slug, state);
      for (const name of await names(dir, false)) {
        if (parseInboxFileName(name) === undefined) continue;
        const path = join(dir, name);
        try {
          const item: unknown = JSON.parse(await readFile(path, "utf8"));
          if (isStoredItem(item))
            entries.push({ slug, state, name, path, item });
        } catch {}
      }
    }
  }
  return entries;
}

/** Writes through a hidden temp file in the same folder, then renames, so no reader sees half a file. */
async function writeAtomic(path: string, content: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomInt(1e9)}.tmp`,
  );
  await writeFile(temp, content);
  await rename(temp, path);
}

const toJson = (item: InboxItem) => `${JSON.stringify(item, null, 2)}\n`;

function split(item: InboxItem): { draft: InboxDraft; stamped: Stamped } {
  const {
    schema: _schema,
    id,
    files,
    from,
    createdAt,
    updatedAt,
    expiresAt,
    updates,
    status,
    closed,
    ...draft
  } = item;
  return {
    draft,
    stamped: {
      id,
      files,
      from,
      createdAt,
      updatedAt,
      expiresAt,
      updates,
      status,
      closed,
    },
  };
}

/** An item with its keys in file order and no empty values. */
function compose(draft: InboxDraft, stamped: Stamped): InboxItem {
  return {
    schema: INBOX_SCHEMA_ID,
    id: stamped.id,
    project: draft.project,
    kind: draft.kind,
    severity: draft.severity,
    title: draft.title,
    ...(draft.startHere !== undefined && { startHere: draft.startHere }),
    ...(draft.ask !== undefined && { ask: draft.ask }),
    ...(draft.details !== undefined && { details: draft.details }),
    ...(draft.work !== undefined && { work: draft.work }),
    ...(draft.refs !== undefined && { refs: draft.refs }),
    ...(stamped.files !== undefined &&
      stamped.files.length > 0 && { files: stamped.files }),
    ...(draft.replyTo !== undefined && { replyTo: draft.replyTo }),
    ...(draft.to !== undefined && { to: draft.to }),
    ...(draft.relatesTo !== undefined && { relatesTo: draft.relatesTo }),
    ...(draft.dedupeKey !== undefined && { dedupeKey: draft.dedupeKey }),
    from: stamped.from,
    createdAt: stamped.createdAt,
    updatedAt: stamped.updatedAt,
    expiresAt: stamped.expiresAt,
    ...(stamped.updates !== undefined &&
      stamped.updates.length > 0 && { updates: stamped.updates }),
    status: stamped.status,
    ...(stamped.closed !== undefined && { closed: stamped.closed }),
  };
}

function randomItemId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += ALPHABET.charAt(randomInt(ALPHABET.length));
  return id;
}

/** `a` with `b`'s keys over it, one level deep. */
function overlay<T extends object>(a: T | undefined, b: T | undefined) {
  return a === undefined || b === undefined ? (b ?? a) : { ...a, ...b };
}

function givenSeverity(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || !("severity" in raw))
    return false;
  return typeof raw.severity === "string" && raw.severity.trim() !== "";
}

/** The old draft with the given one over it; ask, details and work merge by key. */
function mergeDraft(
  old: InboxDraft,
  given: InboxDraft,
  keepSeverity: boolean,
): InboxDraft {
  return {
    ...old,
    ...given,
    severity: keepSeverity ? given.severity : old.severity,
    ...(overlay(old.ask, given.ask) && { ask: overlay(old.ask, given.ask) }),
    ...(overlay(old.details, given.details) && {
      details: overlay(old.details, given.details),
    }),
    ...(overlay(old.work, given.work) && {
      work: overlay(old.work, given.work),
    }),
  };
}

const invalid = (errors: readonly InboxIssue[]): InboxFailure => ({
  ok: false,
  kind: "invalid",
  errors,
});

/** `raw` when it is one of `values`; otherwise the problem goes to `errors`. */
function pick<T extends string>(
  values: readonly T[],
  raw: string | undefined,
  path: string,
  errors: InboxIssue[],
): T | undefined {
  if (raw === undefined) return undefined;
  const value = values.find((v) => v === raw.trim());
  if (value === undefined)
    errors.push({
      path,
      message: `${JSON.stringify(raw)} is not allowed; use one of: ${values.join(", ")}`,
    });
  return value;
}

/** The inbox of one root, with an injectable clock and id source. */
export function inboxStore(options: InboxStoreOptions = {}): InboxStore {
  const root = options.root ?? inboxRoot(options.env ?? process.env);
  const clock = options.now ?? Date.now;

  const newId = (taken: ReadonlySet<string>) => {
    for (let i = 0; i < ID_TRIES; i++) {
      const id = (options.randomId ?? randomItemId)();
      if (!taken.has(id)) return id;
    }
    throw new Error("could not find a free inbox id");
  };

  const countOpen = async (slug: string) =>
    (await names(join(root, slug, "open"), false)).filter(
      (name) => parseInboxFileName(name) !== undefined,
    ).length;

  /** Moves an open entry to closed/: write the closed file, then remove the open one. */
  const closeEntry = async (entry: Entry, closed: InboxClosed, at: string) => {
    const { draft, stamped } = split(entry.item);
    const item = compose(draft, {
      ...stamped,
      updatedAt: at,
      status: "closed",
      closed,
    });
    const path = join(root, entry.slug, "closed", entry.name);
    await writeAtomic(path, toJson(item));
    await rm(entry.path, { force: true });
    return path;
  };

  const prune = async (): Promise<InboxExpired[]> => {
    const now = clock();
    const at = inboxTimestamp(now);
    const entries = await scan(root);
    const closedIds = new Set(
      entries.filter((e) => e.state === "closed").map((e) => e.item.id),
    );
    const expired: InboxExpired[] = [];
    for (const entry of entries) {
      const { item } = entry;
      if (entry.state === "open") {
        if (closedIds.has(item.id)) {
          await rm(entry.path, { force: true });
        } else if (isInboxExpired(item, now)) {
          await closeEntry(
            entry,
            { at, by: "grokbot", outcome: "expired", reason: EXPIRED_REASON },
            at,
          );
          expired.push({
            id: item.id,
            project: item.project,
            title: item.title,
          });
        }
        continue;
      }
      const closedAt = Date.parse(item.closed?.at ?? "");
      if (
        !Number.isNaN(closedAt) &&
        now - closedAt > INBOX_CLOSED_RETENTION_DAYS * DAY_MS
      ) {
        await rm(entry.path, { force: true });
        await rm(join(root, entry.slug, "files", item.id), {
          recursive: true,
          force: true,
        });
      }
    }
    return expired;
  };

  const written = async (
    entry: Pick<Entry, "slug" | "path">,
    item: InboxItem,
  ): Promise<InboxWritten> => {
    const expired = await prune();
    return {
      id: item.id,
      project: item.project,
      slug: entry.slug,
      path: entry.path,
      openInProject: await countOpen(entry.slug),
      expired,
    };
  };

  const locate = async (
    id: string,
  ): Promise<{ entry: Entry } | InboxFailure> => {
    const hits = (await scan(root)).filter((e) => e.item.id === id);
    // An id in both folders is a close that stopped half way: closed wins.
    const entry = hits.find((e) => e.state === "closed") ?? hits[0];
    if (entry === undefined)
      return {
        ok: false,
        kind: "not-found",
        errors: [{ path: "id", message: `no inbox item "${id}"` }],
      };
    if (entry.state === "closed")
      return {
        ok: false,
        kind: "closed",
        errors: [
          {
            path: "id",
            message: `inbox item "${id}" is already closed (${entry.item.closed?.outcome ?? "closed"})`,
          },
        ],
      };
    return { entry };
  };

  return {
    root,

    async post(request) {
      const checked = validateInboxDraft(request.draft);
      if (!checked.ok) return invalid(checked.errors);
      const staged = await stageInboxFiles(request.files ?? []);
      if (!staged.ok) return invalid(staged.errors);
      const given = checked.item;
      const now = clock();
      const at = inboxTimestamp(now);
      const slug = inboxSlug(given.project);
      const entries = await scan(root);
      const match =
        given.dedupeKey === undefined
          ? undefined
          : entries.find(
              (e) =>
                e.slug === slug &&
                e.state === "open" &&
                e.item.dedupeKey === given.dedupeKey,
            );
      if (match && match.item.kind !== given.kind)
        return invalid([
          {
            path: "kind",
            message: `an open ${match.item.kind} in this project already has dedupeKey "${given.dedupeKey}"; use another dedupeKey or close item ${match.item.id}`,
          },
        ]);

      const id =
        match?.item.id ?? newId(new Set(entries.map((e) => e.item.id)));
      const fresh: InboxFile[] = staged.files.map(withPath(id));
      const kept = (match?.item.files ?? []).filter(
        (file) => !fresh.some((f) => f.name === file.name),
      );
      const files = [...kept, ...fresh];
      const bytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
      if (files.length > INBOX_LIMITS.files || bytes > INBOX_LIMITS.fileBytes)
        return invalid([
          {
            path: "files",
            message: `the item would hold ${files.length} files of ${bytes} bytes; the limits are ${INBOX_LIMITS.files} files and ${INBOX_LIMITS.fileBytes} bytes together`,
          },
        ]);

      let item: InboxItem;
      let path: string;
      if (match) {
        const { draft, stamped } = split(match.item);
        const merged = validateInboxDraft(
          mergeDraft(draft, given, givenSeverity(request.draft)),
        );
        if (!merged.ok) return invalid(merged.errors);
        item = compose(merged.item, {
          ...stamped,
          files,
          updatedAt: at,
          expiresAt: inboxExpiresAt(now, given.kind, request.expiresInMs),
          updates: [
            ...(stamped.updates ?? []),
            { at, run: request.from.run, note: "re-posted" },
          ].slice(-INBOX_LIMITS.updates),
        });
        path = match.path;
      } else {
        item = compose(given, {
          id,
          files,
          from: request.from,
          createdAt: at,
          updatedAt: at,
          expiresAt: inboxExpiresAt(now, given.kind, request.expiresInMs),
          status: "open",
        });
        path = join(root, slug, "open", inboxFileName(at, given.kind, id));
      }

      const folder = join(root, slug, "files", id);
      try {
        await copyFiles(folder, staged.files);
        await writeAtomic(path, toJson(item));
      } catch (error) {
        if (!match) await rm(folder, { recursive: true, force: true });
        throw error;
      }
      return {
        ok: true,
        deduped: match !== undefined,
        ...(await written({ slug, path }, item)),
      };
    },

    async update(request) {
      const errors: InboxIssue[] = [];
      const note = validateInboxText(request.note, "note", INBOX_LIMITS.text, {
        required: true,
      });
      errors.push(...note.errors);
      const severity = pick(
        INBOX_SEVERITIES,
        request.severity,
        "severity",
        errors,
      );
      const state = pick(INBOX_WORK_STATES, request.state, "state", errors);
      if (errors.length > 0 || note.value === undefined) return invalid(errors);
      const found = await locate(request.id);
      if ("ok" in found) return found;
      const { entry } = found;
      const { draft, stamped } = split(entry.item);
      const at = inboxTimestamp(clock());
      const item = compose(
        {
          ...draft,
          ...(severity && { severity }),
          ...(state && { work: withState(draft, state) }),
        },
        {
          ...stamped,
          updatedAt: at,
          updates: [
            ...(stamped.updates ?? []),
            {
              at,
              ...(request.run !== undefined && { run: request.run }),
              note: note.value,
            },
          ].slice(-INBOX_LIMITS.updates),
        },
      );
      await writeAtomic(entry.path, toJson(item));
      return { ok: true, ...(await written(entry, item)) };
    },

    async close(request) {
      const errors: InboxIssue[] = [];
      const outcome = pick(INBOX_OUTCOMES, request.outcome, "outcome", errors);
      const reason = validateInboxText(
        request.reason,
        "reason",
        INBOX_LIMITS.text,
      );
      const ref = validateInboxUrl(request.ref, "ref");
      errors.push(...reason.errors, ...ref.errors);
      if (errors.length > 0 || outcome === undefined) return invalid(errors);
      const found = await locate(request.id);
      if ("ok" in found) return found;
      const { entry } = found;
      const at = inboxTimestamp(clock());
      const closed: InboxClosed = {
        at,
        by: request.by,
        outcome,
        ...(reason.value !== undefined && { reason: reason.value }),
        ...(ref.value !== undefined && { ref: ref.value }),
      };
      const path = await closeEntry(entry, closed, at);
      return {
        ok: true,
        ...(await written({ slug: entry.slug, path }, entry.item)),
      };
    },

    prune,
  };
}

const withPath =
  (id: string) =>
  (file: StagedFile): InboxFile => ({
    name: file.name,
    path: `files/${id}/${file.name}`,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
    sha256: file.sha256,
  });

async function copyFiles(folder: string, files: readonly StagedFile[]) {
  for (const file of files)
    await writeAtomic(join(folder, file.name), file.data);
}

/** The draft's `work` with `state` first, as in the file order. */
function withState(draft: InboxDraft, state: InboxWorkState) {
  const { state: _old, ...rest } = draft.work ?? {};
  return { state, ...rest };
}
