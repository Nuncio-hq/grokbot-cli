import { join } from "node:path";
import type { GovernanceOutputs } from "./command-outputs-governance.js";
import type { RunnerContext } from "./command-runner-context.js";
import { listComputers } from "./governance-box-handlers.js";
import type { GovernanceDeps, WorkerChild } from "./governance-deps.js";
import type { TokenFifoServer } from "./governance-token-fifo.js";
import {
  planWorker,
  TOKEN_FIFO,
  type WorkerRun,
  workerEnv,
} from "./governance-worker.js";

export async function previewWorker(
  ctx: RunnerContext,
  deps: GovernanceDeps,
  input: { readonly name?: string },
  cliPath: string,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["worker-plan"]> {
  const named = input.name === undefined ? {} : { name: input.name };
  const preview: WorkerRun = { runDir: "$RUN_DIR", cliPath, ...named };
  const { computers } = await listComputers(ctx, signal);
  return {
    plan: planWorker(preview, deps.parentEnv),
    registered: computers.map((c) => c.label || c.machineId.slice(0, 8)),
  };
}

/** Removes run dirs this user left behind whose grokbot is gone. A failed removal never blocks a start. */
function sweepStaleRunDirs(
  deps: GovernanceDeps,
  dirs: Awaited<ReturnType<GovernanceDeps["listRunDirs"]>>,
): void {
  for (const { dir, ownerPid, uid } of dirs) {
    if (uid !== deps.uid || ownerPid === undefined || deps.isAlive(ownerPid)) {
      continue;
    }
    try {
      deps.removeDir(dir);
    } catch {
      // Left for a later start; this one makes its own fresh dir.
    }
  }
}

function exitOrAbort(
  exited: Promise<number | null>,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  if (signal === undefined) return exited;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void exited.then((code) => {
      signal.removeEventListener("abort", onAbort);
      resolve(code);
    });
  });
}

/**
 * Starts the worker and waits for it to exit. The token is served only while the worker
 * runs. One synchronous cleanup (stop serving, kill the worker, remove the run dir) runs on
 * normal exit, on abort, and from the process exit hook, so a CLI that calls process.exit
 * still leaves nothing behind. Dirs a crashed run left are swept on the next start.
 */
export async function startWorker(
  deps: GovernanceDeps,
  input: { readonly name?: string },
  cliPath: string,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["worker-start"]> {
  signal?.throwIfAborted();
  sweepStaleRunDirs(deps, await deps.listRunDirs());
  const named = input.name === undefined ? {} : { name: input.name };
  const runDir = await deps.makeRunDir();
  const workerRun: WorkerRun = { runDir, cliPath, ...named };
  const plan = planWorker(workerRun, deps.parentEnv);
  const fifoPath = join(runDir, TOKEN_FIFO);
  let fifo: TokenFifoServer | undefined;
  let child: WorkerChild | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fifo?.stop();
    child?.kill("SIGTERM");
    deps.removeDir(runDir);
  };
  const unregister = deps.onTerminate(cleanup);
  try {
    await deps.makeFifo(fifoPath);
    child = deps.spawnWorker(
      plan.command,
      workerEnv(workerRun, deps.parentEnv),
    );
    fifo = deps.serveToken(fifoPath);
    const exitCode = await exitOrAbort(child.exited, signal);
    return { plan, exitCode, tokenServes: fifo.serves };
  } finally {
    cleanup();
    unregister();
  }
}
