import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/**
 * One entry of `~/.grokbot/local-tool-approvals.json`, the file the Mac `local-exec-daemon`
 * reads before running an approved command (REA on `/Applications/Grok Bot.app`, v0.70.2,
 * fct `fC`/`Lh`/`rDe`). The daemon keys entries by `id` and compares `machineId`, `action`,
 * `target` and `accountScope`; the desktop app omits `machineId` when it records one, and
 * so do we (REA fct `recordLocalToolApproval`).
 */
interface LocalApproval {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly accountScope?: string;
}

/** What one record changed, so the caller can put the file back if the server refuses. */
interface LocalApprovalWrite {
  readonly entry: LocalApproval;
  /** The row this id held before, whole; undefined when the id was new. */
  readonly previous: JsonObject | undefined;
}

/** Everything the writer touches, injectable so tests use a temp dir and a clock. */
export interface LocalApprovalsStore {
  readonly path: string;
  /** Reads `~/.grokbot/settings.json` `activeAccountScope`; undefined when absent. */
  readonly readActiveAccountScope: () => Promise<string | undefined>;
}

const GROKBOT_DIR = ".grokbot";
const APPROVALS_FILE = "local-tool-approvals.json";
const SETTINGS_FILE = "settings.json";

/** The default store, reading from `~/.grokbot` on this Mac. */
export function localApprovalsStore(
  home: string = homedir(),
): LocalApprovalsStore {
  const dir = join(home, GROKBOT_DIR);
  return {
    path: join(dir, APPROVALS_FILE),
    readActiveAccountScope: async () => {
      const text = await readFile(join(dir, SETTINGS_FILE), "utf8").catch(
        () => undefined,
      );
      if (text === undefined) return undefined;
      const settings = (() => {
        try {
          return asJsonObject(JSON.parse(text));
        } catch {
          return undefined;
        }
      })();
      return settings ? readString(settings, "activeAccountScope") : undefined;
    },
  };
}

/** Rows by id, each kept whole so fields the app adds (e.g. `resourcePath`) survive a rewrite. */
type Rows = Map<string, JsonObject>;

const refuse = (path: string, problem: string) =>
  new GrokBotError(
    "protocol",
    `${path} ${problem}, so grokbot will not rewrite it. Fix or remove it, then retry.`,
  );

/** Reads the file's rows, dropping ones the daemon would skip. Throws rather than lose a file it cannot read. */
async function readRows(path: string): Promise<Rows> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const rows: Rows = new Map();
  if (text === undefined) return rows;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse(path, "is not valid JSON");
  }
  const list = asJsonObject(parsed)?.approvals;
  if (!Array.isArray(list)) throw refuse(path, "has no approvals list");
  for (const item of list) {
    const row = asJsonObject(item);
    const id = row ? readString(row, "id") : undefined;
    if (
      row &&
      id &&
      readString(row, "action") !== undefined &&
      readString(row, "target") !== undefined
    ) {
      rows.set(id, row);
    }
  }
  return rows;
}

/** Writes atomically (temp file plus rename) so a crash never leaves a half-written file. */
async function writeRows(path: string, rows: Rows): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(
    temp,
    JSON.stringify({ approvals: [...rows.values()] }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temp, path);
}

/**
 * Records a local-tool approval so the Mac daemon lets the command run. Keyed by `id`, so a
 * retry overwrites rather than duplicates, and every other row is kept as it was.
 */
export async function recordLocalApproval(
  store: LocalApprovalsStore,
  request: {
    readonly id: string;
    readonly action: string;
    readonly target: string;
  },
): Promise<LocalApprovalWrite> {
  const rows = await readRows(store.path);
  const accountScope = await store.readActiveAccountScope();
  const entry: LocalApproval = {
    id: request.id,
    action: request.action,
    target: request.target,
    ...(accountScope !== undefined && accountScope !== ""
      ? { accountScope }
      : {}),
  };
  const previous = rows.get(entry.id);
  rows.set(entry.id, { ...entry });
  await writeRows(store.path, rows);
  return { entry, previous };
}

/** Puts the id back the way `recordLocalApproval` found it: the earlier row, or no row. */
export async function undoLocalApproval(
  store: LocalApprovalsStore,
  write: LocalApprovalWrite,
): Promise<void> {
  const rows = await readRows(store.path);
  if (write.previous === undefined) rows.delete(write.entry.id);
  else rows.set(write.entry.id, write.previous);
  await writeRows(store.path, rows);
}
