import { join } from "node:path";
import type { WorkerPlan } from "./command-outputs-governance.js";

/**
 * Spawning `cursor-agent worker start` as the GrokBot account without touching the Cursor
 * IDE login. From reading `~/.local/share/cursor-agent` (v2026.10.01):
 *
 *  - `worker start` takes its bearer from `--auth-token`, `--auth-token-file`, or a stored
 *    login. Its worker path reads no token env var, and `--auth-token` on argv would show
 *    the token in the process list. `--auth-token-file` is re-read before each connect,
 *    so a FIFO serves the token per read (budgeted) while nothing is written to disk.
 *  - `AGENT_CLI_CREDENTIAL_STORE=memory` keeps the token in RAM and skips the Keychain.
 *    CURSOR_CONFIG_DIR and CURSOR_DATA_DIR point into the run dir, so the IDE CLI's
 *    `cli-config.json` (which holds the logged-in account) is never rewritten.
 *  - HOME stays real so bc-* jobs keep git, ssh, Xcode, and simulators.
 */
export interface WorkerRun {
  /** Private 0700 dir for this run: FIFO, config, data, and the owner pid. */
  readonly runDir: string;
  readonly cliPath: string;
  readonly name?: string;
}

export const TOKEN_FIFO = "token.fifo";
export const OWNER_PID = "owner.pid";

/**
 * Parent env vars the worker inherits. Anything else (API keys, tokens) stays out.
 * SSH_AUTH_SOCK is a socket path, not a key: it lets bc-* jobs use the owner's ssh-agent
 * for git over ssh, and the agent never hands out the keys themselves.
 */
const INHERITED = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMPDIR",
  "USER",
];

/** Env the worker runs with. Values are paths or modes, never secrets. */
export function workerEnv(
  run: WorkerRun,
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    AGENT_CLI_CREDENTIAL_STORE: "memory",
    CURSOR_CONFIG_DIR: join(run.runDir, "config"),
    CURSOR_DATA_DIR: join(run.runDir, "data"),
  };
}

/** The exact argv and env-name plan. Parent `worker` flags go before `start`. */
export function planWorker(
  run: WorkerRun,
  parent: Readonly<Record<string, string | undefined>>,
): WorkerPlan {
  return {
    command: [
      run.cliPath,
      "worker",
      "--auth-token-file",
      join(run.runDir, TOKEN_FIFO),
      "--data-dir",
      join(run.runDir, "data"),
      ...(run.name === undefined ? [] : ["--name", run.name]),
      "start",
    ],
    envNames: Object.keys(workerEnv(run, parent)).sort(),
  };
}
