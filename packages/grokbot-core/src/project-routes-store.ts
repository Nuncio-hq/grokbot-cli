import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { GrokBotError } from "./contracts.js";
import { normalizeAgentId } from "./protected-bots-store.js";

/** The bot a project folder (or git remote) sends to, and the tag its messages carry. */
export interface ProjectRoute {
  /** Full lowercase agentId. */
  readonly agentId: string;
  /** Prefixed to `send` and `ask` text as `[label] `. */
  readonly label?: string;
}

/** match → route. A match is a normalized git remote (`host/owner/repo`) or an absolute folder path. */
export type ProjectRoutes = ReadonlyMap<string, ProjectRoute>;

/** The key of a route that matches by folder path rather than by git remote. */
export const isPathKey = (key: string): boolean => isAbsolute(key);

const REMOTE_KEY = /^[^\s/]+\/\S+$/;

export interface ProjectRoutesStore {
  readonly path: string;
  read(): Promise<ProjectRoutes>;
  write(routes: ProjectRoutes): Promise<void>;
}

/**
 * `~/.grokbot/grokbot-cli-project-routes.json`:
 * `{ "<match>": { "agentId": "<uuid>", "label"?: "<text>" } }`. A file that cannot be
 * read or parsed throws instead of reading as empty, so a message never silently goes
 * to the wrong bot.
 */
export function projectRoutesStore(
  home: string = homedir(),
): ProjectRoutesStore {
  const path = join(home, ".grokbot", "grokbot-cli-project-routes.json");
  const invalid = (detail: string) =>
    new GrokBotError(
      "safety",
      `${path}: ${detail} Fix or delete the file, then add routes again with grokbot config route.`,
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
        throw invalid(
          'must be an object of "<match>": { "agentId": "<agentId>", "label": "<text>" }.',
        );
      const routes = new Map<string, ProjectRoute>();
      for (const [rawKey, value] of Object.entries(parsed)) {
        const key = isPathKey(rawKey) ? rawKey : rawKey.toLowerCase();
        if (!isPathKey(key) && !REMOTE_KEY.test(key)) {
          throw invalid(
            `"${rawKey}" is neither an absolute folder path nor a git remote like host/owner/repo.`,
          );
        }
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw invalid(`the route for "${rawKey}" must be an object.`);
        const { agentId, label } = value as Record<string, unknown>;
        const id =
          typeof agentId === "string" ? normalizeAgentId(agentId) : undefined;
        if (id === undefined)
          throw invalid(`the agentId of "${rawKey}" is not a full agentId.`);
        if (
          label !== undefined &&
          (typeof label !== "string" || label.trim() === "")
        )
          throw invalid(`the label of "${rawKey}" must be a non-empty string.`);
        routes.set(key, {
          agentId: id,
          ...(label !== undefined && { label: (label as string).trim() }),
        });
      }
      return routes;
    },
    async write(routes) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const sorted = Object.fromEntries(
        [...routes].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      // Write then rename, so a crash never leaves a half-written file behind.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(sorted, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temp, path);
    },
  };
}
