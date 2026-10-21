import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isPathKey,
  type ProjectRoute,
  type ProjectRoutes,
} from "./project-routes-store.js";

const GIT_TIMEOUT_MS = 5000;

/**
 * `https://host/owner/repo.git`, `git@host:owner/repo`, `ssh://git@host:22/owner/repo/`
 * and the like → `host/owner/repo` in lowercase, with no credentials, port, or `.git`.
 * Undefined for a local path or anything that is not a host and a path.
 */
export function normalizeRemote(url: string): string | undefined {
  const text = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(text);
    host = scp?.[1] ?? "";
    path = scp?.[2] ?? "";
  }
  path = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (host === "" || path === "") return undefined;
  return `${host}/${path}`.toLowerCase();
}

/** The folder's `remote.origin.url`, normalized; undefined with no git, no repo or no remote. */
async function remoteOf(cwd: string): Promise<string | undefined> {
  const url = await new Promise<string>((done) => {
    execFile(
      "git",
      ["-C", cwd, "config", "--get", "remote.origin.url"],
      { timeout: GIT_TIMEOUT_MS },
      (error, stdout) => done(error ? "" : stdout),
    );
  });
  return normalizeRemote(url);
}

const realOrResolved = (path: string) =>
  realpath(path).catch(() => resolve(path));

/** What `grokbot config route` keys a folder by: its git remote when it has one, and its real path. */
export async function projectKeys(
  cwd: string,
): Promise<{ readonly remote?: string; readonly path: string }> {
  const [remote, path] = await Promise.all([
    remoteOf(cwd),
    realOrResolved(cwd),
  ]);
  return { ...(remote !== undefined && { remote }), path };
}

export interface MatchedRoute extends ProjectRoute {
  /** The key it matched by: a normalized remote or an absolute folder path. */
  readonly match: string;
}

const isWithin = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/**
 * The route for a folder. The folder's git remote wins; otherwise the longest path route
 * that equals the folder or is one of its parents (real paths, whole segments).
 */
export async function routeForFolder(
  routes: ProjectRoutes,
  cwd: string,
): Promise<MatchedRoute | undefined> {
  if (routes.size === 0) return undefined;
  const { remote, path } = await projectKeys(cwd);
  const byRemote = remote === undefined ? undefined : routes.get(remote);
  if (remote !== undefined && byRemote !== undefined)
    return { match: remote, ...byRemote };
  let best: (MatchedRoute & { readonly length: number }) | undefined;
  for (const [key, route] of routes) {
    if (!isPathKey(key)) continue;
    const real = await realOrResolved(key);
    if (!isWithin(real, path)) continue;
    if (best === undefined || real.length > best.length)
      best = { match: key, length: real.length, ...route };
  }
  if (best === undefined) return undefined;
  const { length: _length, ...matched } = best;
  return matched;
}
