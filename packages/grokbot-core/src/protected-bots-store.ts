import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GrokBotError } from "./contracts.js";

/**
 * How the user marked a bot on this computer. Both are protected from fire and from
 * skill and routine changes; "main" means never experiment on it, "test" means agents
 * may run experiments there.
 */
export type ProtectedRole = "main" | "test";
export const PROTECTED_ROLES: readonly ProtectedRole[] = ["main", "test"];

/** agentId (lowercase) → role. Empty until the user marks a bot. */
export type ProtectedBots = ReadonlyMap<string, ProtectedRole>;

export const isProtectedRole = (value: unknown): value is ProtectedRole =>
  value === "main" || value === "test";

const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A full agentId in lowercase, or undefined when `value` is not one. */
export function normalizeAgentId(value: string): string | undefined {
  const id = value.trim().toLowerCase();
  return AGENT_ID.test(id) ? id : undefined;
}

export interface ProtectedBotsStore {
  readonly path: string;
  read(): Promise<ProtectedBots>;
  write(bots: ProtectedBots): Promise<void>;
}

/**
 * `~/.grokbot/grokbot-cli-protected-bots.json`: `{ "<agentId>": "main" | "test" }`.
 * Kept apart from grokbot-cli.json so an older grokbot rewriting its settings never
 * drops the list. A file that cannot be read or parsed throws instead of reading as
 * empty, so a broken list never silently lifts the protection.
 */
export function protectedBotsStore(
  home: string = homedir(),
): ProtectedBotsStore {
  const path = join(home, ".grokbot", "grokbot-cli-protected-bots.json");
  const invalid = (detail: string) =>
    new GrokBotError(
      "safety",
      `${path}: ${detail} Fix or delete the file, then mark bots again with grokbot config protect.`,
    );
  return {
    path,
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return new Map();
        throw invalid("cannot be read.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw invalid("is not valid JSON.");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw invalid('must be an object of "<agentId>": "main" | "test".');
      const bots = new Map<string, ProtectedRole>();
      for (const [key, role] of Object.entries(parsed)) {
        const id = normalizeAgentId(key);
        if (id === undefined) throw invalid(`"${key}" is not a full agentId.`);
        if (!isProtectedRole(role))
          throw invalid(`the role of ${id} must be "main" or "test".`);
        bots.set(id, role);
      }
      return bots;
    },
    async write(bots) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const sorted = Object.fromEntries(
        [...bots].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      // Write then rename, so a crash never leaves a half-written list behind.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temp, path);
    },
  };
}
