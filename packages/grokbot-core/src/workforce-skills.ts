import { basename, dirname, resolve } from "node:path";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/** One entry of the Cloud Box skill library (a "workflow" on the wire). The library is Box-wide: every bot sees the same one. */
export interface Skill {
  readonly id: string;
  readonly name: string;
  /** `workflow` for imported skills; `plugin` and `managed` come with the box. */
  readonly source: string;
  readonly description: string;
}

/** A library entry as the gateway lists it, with its markdown body when the list carries one. */
export interface LibraryEntry extends Skill {
  readonly body: string | undefined;
}

export const BOX_WIDE = "Box-wide (all bots) skill library";
const IMPORTED = "workflow";

function fail(method: string, problem: string): never {
  throw new GrokBotError("protocol", `${method}: ${problem}`);
}

function parseEntry(raw: unknown, method: string): LibraryEntry {
  const o = asJsonObject(raw);
  const id = o && readString(o, "id");
  if (!o || !id) fail(method, "a skill has no id");
  return {
    id,
    name: readString(o, "name") ?? "",
    source: readString(o, "source") ?? "",
    description: readString(o, "description") ?? "",
    body: readString(o, "body"),
  };
}

export const toSkill = ({ id, name, source, description }: Skill): Skill => ({
  id,
  name,
  source,
  description,
});

/** Parses a skill library, sent either bare or as `{ workflows }`. */
export function parseLibrary(
  raw: unknown,
  method: string,
): readonly LibraryEntry[] {
  const rows = Array.isArray(raw) ? raw : asJsonObject(raw)?.workflows;
  if (!Array.isArray(rows)) fail(method, "no skill list");
  return rows.map((row) => parseEntry(row, method));
}

/** The skills an `importAgentWorkflowText` reply says it imported, read from its `workflows`. */
export function parseImportReply(raw: unknown): readonly Skill[] {
  const method = "importAgentWorkflowText";
  const reply: JsonObject = asJsonObject(raw) ?? {};
  const imported = asJsonObject(reply.result)?.imported;
  if (!Array.isArray(imported)) fail(method, "no result.imported list");
  const library = parseLibrary(reply.workflows ?? [], method);
  return imported.map((row) => {
    const { id } = parseEntry(row, method);
    return toSkill(library.find((s) => s.id === id) ?? parseEntry(row, method));
  });
}

const sameText = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
const matches = (s: Skill, query: string) =>
  s.id === query.trim() || sameText(s.name, query);

/** By exact id, else by case-insensitive name. */
function hitsFor(entries: readonly LibraryEntry[], query: string) {
  const byId = entries.filter((s) => s.id === query.trim());
  return byId.length > 0
    ? byId
    : entries.filter((s) => sameText(s.name, query));
}

/**
 * The one skill `query` names. Only imported skills count unless `includeManaged`, so a
 * name typo can never reach a skill the box ships with.
 */
export function findSkill(
  library: readonly LibraryEntry[],
  query: string,
  includeManaged = false,
): LibraryEntry {
  const q = query.trim();
  const scope = includeManaged
    ? library
    : library.filter((s) => s.source === IMPORTED);
  const hits = hitsFor(scope, q);
  const [only] = hits;
  if (only && hits.length === 1) return only;
  if (hits.length > 1) {
    throw new GrokBotError(
      "ambiguous",
      `${hits.length} skills are named "${q}": ${hits.map((s) => s.id).join(", ")}. Pass the id.`,
    );
  }
  const kind = includeManaged ? "skill" : "imported skill";
  const builtIn = library.find((s) => matches(s, q));
  const hint = builtIn
    ? `${builtIn.name || builtIn.id} is a ${builtIn.source} skill; pass --include-managed (grokbot CLI only) to act on it.`
    : "List them with grokbot skills-list.";
  throw new GrokBotError(
    "not-found",
    `No ${kind} "${q}" in the ${BOX_WIDE}. ${hint}`,
  );
}

/** The imported skill a push would collide with; throws when the name belongs to a built-in skill. */
export function pushTarget(
  library: readonly LibraryEntry[],
  name: string,
): LibraryEntry | undefined {
  const hits = library.filter((s) => matches(s, name));
  const builtIn = hits.find((s) => s.source !== IMPORTED);
  if (builtIn) {
    throw new GrokBotError(
      "ambiguous",
      `"${builtIn.name}" (${builtIn.id}) is a ${builtIn.source} skill in the ${BOX_WIDE}. Import yours under another name with --name.`,
    );
  }
  return hits[0];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const field = (block: string, key: string) =>
  new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m")
    .exec(block)?.[1]
    ?.replace(/^(["'])(.*)\1$/, "$2")
    .trim();
const normalized = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** The SKILL.md frontmatter `name`, else the name of the folder holding the file, else "". */
export function skillName(markdown: string, filePath?: string): string {
  const name = field(FRONTMATTER.exec(markdown)?.[1] ?? "", "name");
  if (name) return name;
  return filePath ? basename(dirname(resolve(filePath))) : "";
}

/**
 * Whether `markdown` holds what the library stores for `entry`: the gateway keeps the
 * text after the frontmatter as `body` and the frontmatter description as `description`.
 * Undefined when the list did not carry the body.
 */
export function sameContent(
  entry: LibraryEntry,
  markdown: string,
): boolean | undefined {
  if (entry.body === undefined) return undefined;
  const front = FRONTMATTER.exec(markdown);
  const description = field(front?.[1] ?? "", "description");
  const body = front ? markdown.slice(front[0].length) : markdown;
  return (
    normalized(body) === normalized(entry.body) &&
    (description === undefined || description === entry.description.trim())
  );
}
