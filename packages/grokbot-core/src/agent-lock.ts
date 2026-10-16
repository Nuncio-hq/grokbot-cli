import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GrokBotError } from "./contracts.js";

/** A holder sends at most a few RPCs; a lock this old belongs to a process that died. */
const STALE_MS = 30_000;
const RETRY_MS = 100;
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    const [info, text] = await Promise.all([
      stat(path),
      readFile(path, "utf8"),
    ]);
    if (Date.now() - info.mtimeMs > STALE_MS) return true;
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 && !isAlive(pid);
  } catch (error) {
    // Released between our open and this check: try again at once.
    if (isMissing(error)) return true;
    throw error;
  }
}

/**
 * Runs `fn` while holding the bot's lock file in `dir`, so processes (CLI, MCP) never
 * decide "the bot is free, send" for the same bot at once. Not re-entrant: never call
 * it again from inside `fn`.
 */
export async function withAgentLock<T>(
  dir: string,
  agentId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!SAFE_AGENT_ID.test(agentId))
    throw new GrokBotError("protocol", `invalid agent id: ${agentId}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `.lock-${agentId}`);
  for (;;) {
    signal?.throwIfAborted();
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    if (await isStale(path)) await rm(path, { force: true });
    else await delay(RETRY_MS, undefined, { signal });
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
