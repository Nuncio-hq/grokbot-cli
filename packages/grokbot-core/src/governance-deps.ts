import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTokenSource } from "./auth-token-source.js";
import {
  type LocalApprovalsStore,
  localApprovalsStore,
} from "./governance-local-approvals.js";
import {
  serveTokenFifo,
  type TokenFifoServer,
} from "./governance-token-fifo.js";
import { OWNER_PID } from "./governance-worker.js";

/** A spawned worker: resolves with its exit code once it ends. */
export interface WorkerChild {
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

/** A worker run dir left in tmp, with its owner uid and the pid of the grokbot that made it. */
export interface RunDirEntry {
  readonly dir: string;
  readonly ownerPid: number | undefined;
  readonly uid: number;
}

/**
 * Side effects of the governance commands, injectable so tests use fakes and never touch
 * this Mac's approvals file, its browser, its Keychain, or a real cursor-agent.
 */
export interface GovernanceDeps {
  readonly approvals: LocalApprovalsStore;
  /** Opens a URL in the default macOS app. Its errors may carry the URL. */
  readonly openUrl: (url: string) => Promise<void>;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Creates a 0700 run dir holding this process's pid. */
  readonly makeRunDir: () => Promise<string>;
  /** Synchronous, so it can run from a process exit hook. */
  readonly removeDir: (dir: string) => void;
  /** Creates a 0600 FIFO. */
  readonly makeFifo: (path: string) => Promise<void>;
  /** Serves the GrokBot access token, read fresh per serve, through the FIFO. */
  readonly serveToken: (path: string) => TokenFifoServer;
  readonly spawnWorker: (
    command: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => WorkerChild;
  /** Runs `cleanup` synchronously on SIGINT, SIGTERM, and process exit; returns an unregister function. */
  readonly onTerminate: (cleanup: () => void) => () => void;
  readonly listRunDirs: () => Promise<readonly RunDirEntry[]>;
  readonly isAlive: (pid: number) => boolean;
  /** This process's uid; only run dirs it owns are ever swept. */
  readonly uid: number;
}

const RUN_DIR_PREFIX = "grokbot-worker-";
const EXIT_EVENTS = ["SIGINT", "SIGTERM", "exit"] as const;

async function readRunDir(dir: string): Promise<RunDirEntry | undefined> {
  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const text = await readFile(join(dir, OWNER_PID), "utf8").catch(() => "");
  const pid = Number.parseInt(text, 10);
  return {
    dir,
    ownerPid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
    uid: info.uid,
  };
}

export function defaultGovernanceDeps(): GovernanceDeps {
  const run = promisify(execFile);
  // Same source as RPC calls: `grokbot login`'s sign-in first, else the app's token.
  const tokens = createTokenSource();
  return {
    approvals: localApprovalsStore(),
    openUrl: async (url) => {
      await run("open", [url]);
    },
    parentEnv: process.env,
    makeRunDir: async () => {
      const dir = await mkdtemp(join(tmpdir(), RUN_DIR_PREFIX));
      await writeFile(join(dir, OWNER_PID), String(process.pid), {
        mode: 0o600,
      });
      return dir;
    },
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    makeFifo: async (path) => {
      await run("mkfifo", ["-m", "600", path]);
    },
    serveToken: (path) => serveTokenFifo(path, () => tokens.getToken()),
    spawnWorker: (command, env) => {
      const [file = "", ...args] = command;
      const child = spawn(file, args, { env: { ...env }, stdio: "inherit" });
      return {
        exited: new Promise((resolve) => {
          child.once("exit", (code) => resolve(code));
          child.once("error", () => resolve(127));
        }),
        kill: (signal) => child.kill(signal),
      };
    },
    onTerminate: (cleanup) => {
      const handler = () => cleanup();
      for (const event of EXIT_EVENTS) process.once(event, handler);
      return () => {
        for (const event of EXIT_EVENTS) process.off(event, handler);
      };
    },
    listRunDirs: async () => {
      const names = await readdir(tmpdir()).catch(() => [] as string[]);
      const entries = await Promise.all(
        names
          .filter((name) => name.startsWith(RUN_DIR_PREFIX))
          .map((name) => readRunDir(join(tmpdir(), name))),
      );
      return entries.filter((entry) => entry !== undefined);
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    uid: process.getuid?.() ?? -1,
  };
}
