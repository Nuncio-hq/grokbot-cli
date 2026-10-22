import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What this computer last asked the bots' cloud computer to install, and when it last said so. */
export interface BotsVersionRecord {
  /** The grokbot version a finished `setup-bots` or `update-bots` asked the bots to run. */
  readonly version: string;
  readonly updatedAtMs: number;
  /** When the update notice was last shown, so it shows at most once an hour. */
  readonly noticeShownAtMs?: number;
}

export interface BotsVersionStore {
  readonly path: string;
  /** Undefined when there is no record, or it cannot be read: the bots' version is then unknown. */
  read(): Promise<BotsVersionRecord | undefined>;
  write(record: BotsVersionRecord): Promise<void>;
}

/** Shown at most this often while the bots run another grokbot than this computer. */
export const UPDATE_NOTICE_INTERVAL_MS = 3_600_000;

/** The bots were last updated to `bots` from here, while this computer now runs `here`. */
export interface UpdateNotice {
  readonly here: string;
  readonly bots: string;
}

/**
 * `~/.grokbot/grokbot-cli-bots-version.json`. Only a hint, never a guard: a file that
 * cannot be read or parsed reads as no record, so it can never stop a command.
 */
export function botsVersionStore(home: string = homedir()): BotsVersionStore {
  const path = join(home, ".grokbot", "grokbot-cli-bots-version.json");
  return {
    path,
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const { version, updatedAtMs, noticeShownAtMs } = parsed as Record<
          string,
          unknown
        >;
        if (typeof version !== "string" || typeof updatedAtMs !== "number")
          return undefined;
        return {
          version,
          updatedAtMs,
          ...(typeof noticeShownAtMs === "number" && { noticeShownAtMs }),
        };
      } catch {
        return undefined;
      }
    },
    async write(record) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temp, path);
    },
  };
}

/**
 * The notice that the bots' cloud computer was last updated to another grokbot than the one
 * running here: only when this computer updated it before (so a person who never set the
 * bots' side up is never asked), at most once an hour, and marked shown. Every failure is
 * swallowed: a notice never fails a command.
 */
export async function updateNotice(
  store: BotsVersionStore,
  here: string,
  nowMs: number,
): Promise<UpdateNotice | undefined> {
  try {
    const record = await store.read();
    if (record === undefined || record.version === here) return undefined;
    const shown = record.noticeShownAtMs;
    if (shown !== undefined && nowMs - shown < UPDATE_NOTICE_INTERVAL_MS)
      return undefined;
    await store.write({ ...record, noticeShownAtMs: nowMs });
    return { here, bots: record.version };
  } catch {
    return undefined;
  }
}

/** The one line the CLI prints, and the MCP server adds as a block, for an update notice; `how` names the fix there. */
export function describeUpdateNotice(
  { here, bots }: UpdateNotice,
  how: string,
): string {
  return `Update: this computer runs grokbot ${here}, but the bots' cloud computer was last updated to ${bots}. Bring it to ${here} with ${how}.`;
}
