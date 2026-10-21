import {
  type FileHandle,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { mapBounded } from "./map-bounded.js";
import { isSessionId, parseSessionAddress } from "./session-address.js";
import { type ClientLabel, isSet } from "./usage-client.js";

/** A session file counts as the caller's when it changed this recently. */
export const SESSION_ACTIVE_MS = 120_000;

/** The most bytes read from the end of a candidate session file to tell candidates apart. */
export const SESSION_TAIL_BYTES = 256 * 1024;
/** How many of a candidate's last non-empty lines are searched for this command: the running command sits within the last two. */
export const SESSION_TAIL_LINES = 4;

/** The session of the agent that runs grokbot: its return address and how grokbot found it. */
export interface DetectedSession {
  /** `<runtime>:<id>`, what a bot copies into `--to-session`. */
  readonly address: string;
  /** The runtime as a client label (`omp`, `claude-code`, `codex`...). */
  readonly runtime: string;
  readonly id: string;
  /** `GROKBOT_SESSION`, a runtime's own variable's name, `recent session file`, or `recent session file, matched by this command`; never a value. */
  readonly signal: string;
}

/** The session, or why there is none: `ambiguous` carries how many sessions were active. */
export type CallerSession =
  | DetectedSession
  | {
      readonly signal: "none" | "ambiguous";
      readonly candidates?: number;
    };

export const hasSession = (
  session: CallerSession,
): session is DetectedSession => "address" in session;

export interface CallerSessionInput {
  /** Read: GROKBOT_SESSION, the caller's own session variable (CODEX_THREAD_ID, CODEX_SESSION_ID, CLAUDE_CODE_SESSION_ID, CURSOR_CONVERSATION_ID), SAND_AGENT, CLAUDE_CONFIG_DIR, PI_CODING_AGENT_SESSION_DIR. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder grokbot runs in: where the agent's session folder is looked up. */
  readonly cwd: string;
  /** The user's home folder, where the agent runtimes keep their sessions. */
  readonly home: string;
  /** This invocation's arguments, matched against the end of recent session files when several are candidates. Default: `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  /** Epoch ms now. Default: Date.now. */
  readonly now?: () => number;
  /** Who is calling, as `detectClient` labels it. A person or an unknown caller has no session. */
  readonly caller: ClientLabel | undefined;
}

const NONE: CallerSession = { signal: "none" };

const found = (runtime: string, id: string, signal: string): CallerSession => ({
  address: `${runtime}:${id}`,
  runtime,
  id,
  signal,
});

/**
 * `GROKBOT_SESSION`: `<runtime>:<id>`, or an `<id>` alone whose runtime is the caller's
 * label. Anything that is neither is ignored, so detection goes on to the other signals.
 */
function fromOwner(
  value: string | undefined,
  caller: ClientLabel,
): { readonly runtime: string; readonly id: string } | undefined {
  const text = value?.trim();
  if (text === undefined || text === "") return undefined;
  const full = parseSessionAddress(text);
  if (full !== undefined) return full;
  return isSessionId(text) ? { runtime: caller, id: text } : undefined;
}

const SEPARATORS = /[/\\:]/g;
/** Claude Code's folder names cut a path at 200 characters and append a hash; those are skipped. */
const CLAUDE_SLUG_MAX = 200;

/** `cwd` and every parent up to `home`; just `cwd` when it is outside `home`. */
function folderChain(cwd: string, home: string): string[] {
  const rel = relative(home, cwd);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside) return [cwd];
  const chain: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.push(dir);
    if (dir === home || dirname(dir) === dir) return chain;
  }
}

/** The runtime's session folder for `dir`, or undefined when its naming does not reach `dir`. */
type SessionFolder = (dir: string) => string | undefined;

/**
 * omp: `<agent dir>/sessions/<slug>`, the folder's path below home with every separator a
 * dash (`-` for home itself). Folders outside home are named another way and are not read.
 */
const ompFolder =
  (home: string): SessionFolder =>
  (dir) => {
    const rel = relative(home, dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return undefined;
    return join(
      home,
      ".omp",
      "agent",
      "sessions",
      `-${rel.replace(SEPARATORS, "-")}`,
    );
  };

/** Claude Code: `<config dir>/projects/<slug>`, the absolute path with every non-alphanumeric a dash. */
const claudeFolder =
  (configDir: string): SessionFolder =>
  (dir) => {
    const slug = dir.replace(/[^a-zA-Z0-9]/g, "-");
    return slug.length > CLAUDE_SLUG_MAX
      ? undefined
      : join(configDir, "projects", slug);
  };

const realOr = async (path: string): Promise<string> =>
  realpath(path).catch(() => path);

/** The id in a session file name, or undefined when the name is not one of this runtime's. */
type IdOfFile = (name: string) => string | undefined;

/** omp: `<YYYY-MM-DDTHH-MM-SS-mmmZ>_<id>.jsonl`. */
const ompId: IdOfFile = (name) => {
  const stem = name.slice(0, -".jsonl".length);
  const cut = stem.lastIndexOf("_");
  const id = cut < 0 ? undefined : stem.slice(cut + 1);
  return id !== undefined && isSessionId(id) ? id : undefined;
};

/** Claude Code: `<id>.jsonl`. */
const claudeId: IdOfFile = (name) => {
  const id = name.slice(0, -".jsonl".length);
  return isSessionId(id) ? id : undefined;
};

/** The first folder of `dirs` that can be listed, with its file names. */
async function firstFolder(
  dirs: readonly string[],
): Promise<{ readonly dir: string; readonly names: string[] } | undefined> {
  for (const dir of dirs) {
    try {
      return { dir, names: await readdir(dir) };
    } catch {
      // Not there (or not readable): the session is in a parent folder.
    }
  }
  return undefined;
}

/** A recent session file: the id in its name and where it is. */
interface SessionFile {
  readonly id: string;
  readonly path: string;
}

/**
 * The session files changed in the last `SESSION_ACTIVE_MS` in the first of `dirs` that
 * exists. Reads names and modification times only, never a file's content.
 */
async function recentSessions(
  dirs: readonly string[],
  idOfFile: IdOfFile,
  nowMs: number,
): Promise<SessionFile[]> {
  const folder = await firstFolder(dirs);
  if (folder === undefined) return [];
  const files = folder.names.flatMap((name) => {
    const id = name.endsWith(".jsonl") ? idOfFile(name) : undefined;
    return id === undefined ? [] : [{ name, id }];
  });
  const recent = await mapBounded(files, 32, async ({ name, id }) => {
    const path = join(folder.dir, name);
    try {
      const info = await stat(path);
      return info.isFile() && nowMs - info.mtimeMs <= SESSION_ACTIVE_MS
        ? { id, path }
        : undefined;
    } catch {
      return undefined;
    }
  });
  return recent.filter((file): file is SessionFile => file !== undefined);
}

/** The last `SESSION_TAIL_BYTES` of a file as text, or undefined when it cannot be read. Never stored or logged. */
async function tailOf(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, SESSION_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        size - length + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.toString("utf8", 0, filled);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** An argument a shell command shows exactly as typed: no space, quote, `$`, backslash or glob. */
const PLAIN_ARG = /^[A-Za-z0-9._:/@=+,%-]+$/;

/**
 * What to look for: runs of plain arguments as the one phrase they were typed as
 * (`inbox check`, not the two common words apart), and every other argument on its own,
 * each JSON-escaped as a session store writes it inside a JSON string.
 */
function commandNeedles(argv: readonly string[]): string[] {
  const needles: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) needles.push(run.join(" "));
    run = [];
  };
  for (const arg of argv) {
    if (arg.length === 0) continue;
    if (PLAIN_ARG.test(arg)) {
      run.push(arg);
      continue;
    }
    flush();
    needles.push(JSON.stringify(arg).slice(1, -1));
  }
  flush();
  return needles;
}

/**
 * The files whose last `SESSION_TAIL_LINES` non-empty lines hold this command (see
 * `commandNeedles`). Runtimes store the agent's command before running it, so the caller's
 * file ends with it. An unreadable file never matches; an empty argument is skipped.
 */
async function matchingCommand(
  files: readonly SessionFile[],
  argv: readonly string[],
): Promise<SessionFile[]> {
  const needles = commandNeedles(argv);
  if (needles.length === 0) return [];
  const matches = await mapBounded(files, 8, async (file) => {
    const tail = await tailOf(file.path);
    if (tail === undefined) return false;
    const last = tail
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-SESSION_TAIL_LINES)
      .join("\n");
    return needles.every((needle) => last.includes(needle));
  });
  return files.filter((_, index) => matches[index]);
}

/** A session id a runtime sets in its own variable, or undefined when absent or not a valid id. */
function fromVariables(
  env: CallerSessionInput["env"],
  runtime: ClientLabel,
  names: readonly string[],
): CallerSession | undefined {
  for (const name of names) {
    const id = env[name]?.trim();
    if (id !== undefined && isSessionId(id)) return found(runtime, id, name);
  }
  return undefined;
}

/**
 * The session of the agent that runs grokbot, so a message and an inbox item can carry a
 * return address. Only the detected runtime's own source is read: a runtime started inside
 * another inherits the outer one's variables, and those are never taken for this one's.
 * Most explicit first:
 * 1. `GROKBOT_SESSION`, set by the owner: `<runtime>:<id>`, or an `<id>` with the caller's runtime;
 * 2. the runtime's own variable: `CLAUDE_CODE_SESSION_ID` (Claude Code), `CODEX_THREAD_ID`
 *    then `CODEX_SESSION_ID` (Codex), `CURSOR_CONVERSATION_ID` (Cursor, unless `SAND_AGENT`
 *    is set, which marks a GrokBot bot's own commands whose id is the bot's, not a chat's);
 * 3. for an omp or Claude Code caller, the one session file of this folder's session folder
 *    (walking up to home until a folder exists) changed in the last two minutes. Its names
 *    and times are all that is read. With two or more such files, the end of each is read
 *    (at most `SESSION_TAIL_BYTES`, its last `SESSION_TAIL_LINES` non-empty lines): the one
 *    that holds every argument of this command, JSON-escaped, is the caller's, because the
 *    runtime stored the command before running it. Nothing read is kept.
 * No such file or several: `ambiguous`, with the count of recent files. A person at
 * a terminal, a caller grokbot cannot name, and every other runtime have no session unless
 * the owner sets `GROKBOT_SESSION`. Ids outside `[A-Za-z0-9._-]{4,100}` are ignored.
 */
export async function detectCallerSession(
  input: CallerSessionInput,
): Promise<CallerSession> {
  const { env, caller } = input;
  if (caller === undefined || caller === "human") return NONE;

  const given = fromOwner(env.GROKBOT_SESSION, caller);
  if (given !== undefined)
    return found(given.runtime, given.id, "GROKBOT_SESSION");

  if (caller === "codex") {
    return (
      fromVariables(env, caller, ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]) ??
      NONE
    );
  }
  if (caller === "cursor") {
    return isSet(env.SAND_AGENT)
      ? NONE
      : (fromVariables(env, caller, ["CURSOR_CONVERSATION_ID"]) ?? NONE);
  }
  if (caller === "claude-code") {
    const own = fromVariables(env, caller, ["CLAUDE_CODE_SESSION_ID"]);
    if (own !== undefined) return own;
  }
  if (caller !== "omp" && caller !== "claude-code") return NONE;
  if (input.home === "") return NONE;

  const home = await realOr(input.home);
  const cwd = await realOr(input.cwd);
  const nowMs = (input.now ?? Date.now)();
  let dirs: string[];
  let idOfFile: IdOfFile;
  if (caller === "omp") {
    // The session-dir override holds the session files directly, with no folder per project.
    const override = env.PI_CODING_AGENT_SESSION_DIR?.trim();
    const folderOf = ompFolder(home);
    dirs = override
      ? [override]
      : folderChain(cwd, home).flatMap((dir) => folderOf(dir) ?? []);
    idOfFile = ompId;
  } else {
    const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
    const folderOf = claudeFolder(configDir);
    dirs = folderChain(cwd, home).flatMap((dir) => folderOf(dir) ?? []);
    idOfFile = claudeId;
  }
  const recent = await recentSessions(dirs, idOfFile, nowMs);
  const [only, ...others] = recent;
  if (only === undefined) return NONE;
  if (others.length === 0) return found(caller, only.id, "recent session file");
  const [match, ...rest] = await matchingCommand(
    recent,
    input.argv ?? process.argv.slice(2),
  );
  return match !== undefined && rest.length === 0
    ? found(caller, match.id, "recent session file, matched by this command")
    : { signal: "ambiguous", candidates: recent.length };
}
