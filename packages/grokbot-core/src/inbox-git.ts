import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InboxGit } from "./inbox-types.js";

const GIT_TIMEOUT_MS = 5000;

/**
 * An origin remote as an https URL without credentials or `.git`, keeping its case:
 * `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo` and `https://u:t@host/owner/repo/`
 * all give `https://host/owner/repo`. Undefined for a local path or anything without a host.
 */
export function httpsRemote(remote: string): string | undefined {
  const text = remote.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(text);
    host = scp?.[1] ?? "";
    path = scp?.[2] ?? "";
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host === "" || path === "" ? undefined : `https://${host}/${path}`;
}

/** Stdout of `git -C cwd <args>`, trimmed; empty when git fails, is missing or the folder is no checkout. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** The checkout `cwd` is in: origin (https form), branch (none when detached) and commit; undefined outside git. */
export async function inboxGitInfo(cwd: string): Promise<InboxGit | undefined> {
  const [remote, branch, commit] = await Promise.all([
    git(cwd, ["config", "--get", "remote.origin.url"]),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(cwd, ["rev-parse", "HEAD"]),
  ]);
  const url = httpsRemote(remote);
  const info: InboxGit = {
    ...(url !== undefined && { url }),
    ...(branch !== "" && { branch }),
    ...(commit !== "" && { commit }),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}
