import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/**
 * A bot's files as the 0.72.0 desktop files pane shows them: the files shared with the
 * bot's team (`ListGrokBotAgentFiles`) and the user's own private ones, "Only you"
 * (`ListGrokBotUserStoreFiles`). The pane only lists, uploads and removes; it has no
 * download, so neither does grokbot.
 */
export type FileSection = "team" | "only-you";

const FILE_SECTIONS: readonly FileSection[] = ["team", "only-you"];

/** One file of either section. Neither listing carries a link to its bytes. */
export interface BotFile {
  readonly section: FileSection;
  readonly name: string;
  /** What `DeleteGrokBotUserStoreFile` takes for an `only-you` file. */
  readonly path: string;
  readonly sizeBytes: number;
  /** ISO time of the last change; null when the server sent none. */
  readonly updatedAt: string | null;
  /** Team files only. */
  readonly contentType?: string;
}

/** What the team listing says about the section as a whole. */
export interface TeamSection {
  /** Bytes the team files use, as the first page reports it. */
  readonly totalBytes: number;
  /** Whether the caller may upload and remove team files. */
  readonly canEdit: boolean;
  /** False when the listing stopped at {@link MAX_TEAM_PAGES} with pages left. */
  readonly complete: boolean;
}

interface TeamListing extends TeamSection {
  readonly files: readonly BotFile[];
}

const TEAM_FILES = "ListGrokBotAgentFiles";
const ONLY_YOU_FILES = "ListGrokBotUserStoreFiles";
export const REMOVE_TEAM_FILE = "DeleteGrokBotAgentFile";
export const REMOVE_ONLY_YOU_FILE = "DeleteGrokBotUserStoreFile";

/** The team listing is paged; follow it this many pages, then say it is cut short. */
export const MAX_TEAM_PAGES = 20;

function fail(method: string, problem: string): never {
  throw new GrokBotError("protocol", `${method}: ${problem}`);
}

/** A proto int64 (a digit string or a number); an omitted zero reads as 0. */
function readInt64(row: JsonObject, key: string, method: string): number {
  const value = row[key];
  if (value === undefined || value === null || value === "") return 0;
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
  return fail(method, `${key} is not a non-negative integer`);
}

/**
 * A team file is removed by its `name` and a private one by its `path`, so the one
 * that removal needs must be on the wire; the other falls back to it.
 */
function parseFile(
  raw: unknown,
  section: FileSection,
  method: string,
): BotFile {
  const row = asJsonObject(raw);
  if (!row) return fail(method, "a file is not an object");
  const name = readString(row, "name") ?? "";
  const path = readString(row, "path") ?? "";
  if ((section === "team" ? name : path) === "") {
    return fail(
      method,
      `a file has no ${section === "team" ? "name" : "path"}`,
    );
  }
  const updatedAtMs = readInt64(row, "updatedAtMs", method);
  const contentType = readString(row, "contentType");
  return {
    section,
    name: name === "" ? (path.split("/").at(-1) ?? path) : name,
    path: path === "" ? name : path,
    sizeBytes: readInt64(row, "sizeBytes", method),
    updatedAt: updatedAtMs === 0 ? null : new Date(updatedAtMs).toISOString(),
    ...(contentType ? { contentType } : {}),
  };
}

function parseFiles(
  raw: unknown,
  section: FileSection,
  method: string,
): readonly BotFile[] {
  const body = asJsonObject(raw);
  if (!body) return fail(method, "the reply is not an object");
  if (body.files === undefined) return [];
  if (!Array.isArray(body.files)) return fail(method, "files is not a list");
  return body.files.map((file) => parseFile(file, section, method));
}

/**
 * Every team file, following `nextPageToken` for at most {@link MAX_TEAM_PAGES} pages.
 * A token the server repeats is a loop and fails rather than spinning.
 */
export async function listTeamFiles(
  server: Pick<ServerTransport, "call">,
  agentId: string,
  signal?: AbortSignal,
): Promise<TeamListing> {
  const files: BotFile[] = [];
  const seen = new Set<string>();
  let first: JsonObject = {};
  let token = "";
  let complete = false;
  for (let page = 0; page < MAX_TEAM_PAGES && !complete; page++) {
    const raw = await server.call(
      TEAM_FILES,
      token === "" ? { agentId } : { agentId, pageToken: token },
      { signal },
    );
    files.push(...parseFiles(raw, "team", TEAM_FILES));
    const body = asJsonObject(raw) ?? {};
    if (page === 0) first = body;
    token = readString(body, "nextPageToken") ?? "";
    complete = token === "";
    if (!complete && seen.has(token)) fail(TEAM_FILES, "repeated a page token");
    seen.add(token);
  }
  return {
    files,
    totalBytes: readInt64(first, "totalBytes", TEAM_FILES),
    canEdit: first.canEdit === true,
    complete,
  };
}

/** The user's private files of one bot (not paged). */
export async function listOnlyYouFiles(
  server: Pick<ServerTransport, "call">,
  agentId: string,
  signal?: AbortSignal,
): Promise<readonly BotFile[]> {
  return parseFiles(
    await server.call(ONLY_YOU_FILES, { agentId }, { signal }),
    "only-you",
    ONLY_YOU_FILES,
  );
}

/** The `--section` value as a section, or undefined when none was given. */
export function parseSection(
  value: string | undefined,
): FileSection | undefined {
  if (value === undefined) return undefined;
  const wanted = value.trim().toLowerCase();
  const section = FILE_SECTIONS.find((s) => s === wanted);
  if (section) return section;
  throw new GrokBotError(
    "safety",
    `--section must be one of ${FILE_SECTIONS.join(", ")}, not ${JSON.stringify(value)}.`,
  );
}

/**
 * The one file `query` names: an exact path, else an exact name. Two files that fit
 * (the same path in both sections, or one name in two folders) never resolve silently,
 * because the caller is about to delete the result.
 */
export function findFile(
  files: readonly BotFile[],
  query: string,
  options: { readonly section?: FileSection; readonly complete: boolean },
): BotFile {
  const q = query.trim();
  const scope = files.filter(
    (f) => options.section === undefined || f.section === options.section,
  );
  const byPath = scope.filter((f) => f.path === q);
  const hits = byPath.length > 0 ? byPath : scope.filter((f) => f.name === q);
  const [only] = hits;
  if (only && hits.length === 1) return only;
  if (hits.length > 1) {
    throw new GrokBotError(
      "ambiguous",
      `${hits.length} files match "${q}": ${hits.map((f) => `${f.section}: ${f.path}`).join("; ")}. Pass the full path, or --section ${FILE_SECTIONS.join(" or --section ")}.`,
    );
  }
  throw new GrokBotError(
    "not-found",
    `No file "${q}"${options.section ? ` in the ${options.section} section` : ""}. List them with grokbot files.${options.complete ? "" : ` The team listing stopped after ${MAX_TEAM_PAGES} pages, so it may be further down.`}`,
  );
}
