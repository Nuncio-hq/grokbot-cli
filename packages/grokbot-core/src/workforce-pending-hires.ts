import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentId, slugify } from "./agents.js";
import { asJsonObject, readString } from "./transcript.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The agentId `hire` sent to a create it has not yet seen land, one file per bot name.
 * A rerun reuses that id, so a create that lands late cannot leave a twin bot.
 * Each file holds the name and the id only.
 */
export interface PendingHires {
  load(name: string): Promise<AgentId | undefined>;
  save(name: string, agentId: AgentId): Promise<void>;
  clear(name: string): Promise<void>;
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

export function pendingHires(dir: string): PendingHires {
  const pathOf = (name: string) =>
    join(dir, `${slugify(name) || "unnamed"}.json`);
  return {
    async load(name) {
      let text: string;
      try {
        text = await readFile(pathOf(name), "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      let record: ReturnType<typeof asJsonObject>;
      try {
        record = asJsonObject(JSON.parse(text));
      } catch {
        return undefined;
      }
      const saved = record && readString(record, "name");
      const agentId = record && readString(record, "agentId");
      return saved !== undefined &&
        sameName(saved, name) &&
        agentId !== undefined &&
        UUID.test(agentId)
        ? (agentId as AgentId)
        : undefined;
    },
    async save(name, agentId) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = pathOf(name);
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          tmp,
          `${JSON.stringify({ name: name.trim(), agentId })}\n`,
          {
            mode: 0o600,
          },
        );
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
    },
    async clear(name) {
      await rm(pathOf(name), { force: true });
    },
  };
}

/** Pending hires sit beside the jobs folder: `~/.grokbot/pending-hires` by default. */
export const pendingHiresBeside = (jobsDir: string): PendingHires =>
  pendingHires(join(dirname(jobsDir), "pending-hires"));
