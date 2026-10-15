import { describe, expect, it, vi } from "vitest";
import {
  governanceRunner,
  workerUntilKilled,
} from "./fixtures/governance-test-kit.js";

const RUN = "/tmp/grokbot-worker-run";
const SPAWN = `spawn /opt/cursor-agent worker --auth-token-file ${RUN}/token.fifo --data-dir ${RUN}/data start | AGENT_CLI_CREDENTIAL_STORE,CURSOR_CONFIG_DIR,CURSOR_DATA_DIR,HOME,PATH,SSH_AUTH_SOCK`;
const start = { yes: true, json: false } as const;

describe("worker-plan", () => {
  it("returns the command, env names, and registered computers, spawning nothing", async () => {
    const { run, events } = governanceRunner({
      ListGrokBotUserComputers: [
        {
          computers: [
            { machineId: "abcdef1234", hello: { label: "Mac" } },
            { machineId: "99887766aa" },
          ],
        },
      ],
    });
    expect([
      await run("worker-plan", { name: "oscar-mac", json: false }),
      events,
    ]).toEqual([
      {
        registered: ["Mac", "99887766"],
        plan: {
          command: [
            "/opt/cursor-agent",
            "worker",
            "--auth-token-file",
            "$RUN_DIR/token.fifo",
            "--data-dir",
            "$RUN_DIR/data",
            "--name",
            "oscar-mac",
            "start",
          ],
          envNames: [
            "AGENT_CLI_CREDENTIAL_STORE",
            "CURSOR_CONFIG_DIR",
            "CURSOR_DATA_DIR",
            "HOME",
            "PATH",
            "SSH_AUTH_SOCK",
          ],
        },
      },
      [],
    ]);
  });
});

describe("worker-start", () => {
  it("serves the token only while the worker runs, reports the serve count, and cleans up", async () => {
    const { run, events } = governanceRunner();
    const out = await run("worker-start", start);
    expect([out.exitCode, out.tokenServes, events]).toEqual([
      0,
      2,
      [
        "make-run-dir",
        "trap",
        `mkfifo ${RUN}/token.fifo`,
        SPAWN,
        `serve ${RUN}/token.fifo`,
        "serve-stop",
        `remove ${RUN}`,
        "untrap",
      ],
    ]);
  });

  it("removes only stale run dirs this user owns, and starts even when a removal fails", async () => {
    const events: string[] = [];
    const { run } = governanceRunner(
      {},
      {},
      {
        listRunDirs: async () => [
          { dir: "/tmp/grokbot-worker-dead", ownerPid: 111, uid: 501 },
          { dir: "/tmp/grokbot-worker-stuck", ownerPid: 112, uid: 501 },
          { dir: "/tmp/grokbot-worker-live", ownerPid: 222, uid: 501 },
          { dir: "/tmp/grokbot-worker-other-user", ownerPid: 333, uid: 502 },
          {
            dir: "/tmp/grokbot-worker-starting",
            ownerPid: undefined,
            uid: 501,
          },
        ],
        isAlive: (pid) => pid === 222,
        removeDir: (dir) => {
          events.push(`remove ${dir}`);
          if (dir.endsWith("stuck")) throw new Error("EACCES");
        },
      },
      events,
    );
    const out = await run("worker-start", start);
    expect([out.exitCode, events.slice(0, 3)]).toEqual([
      0,
      [
        "remove /tmp/grokbot-worker-dead",
        "remove /tmp/grokbot-worker-stuck",
        "make-run-dir",
      ],
    ]);
  });

  it("kills the worker, stops serving, and removes the run dir when the run is aborted", async () => {
    const events: string[] = [];
    const { run } = governanceRunner(
      {},
      {},
      { spawnWorker: workerUntilKilled(events) },
      events,
    );
    const controller = new AbortController();
    const running = run("worker-start", start, { signal: controller.signal });
    await vi.waitFor(() => expect(events).toContain("spawn"));
    controller.abort();
    const error = await running.catch((e: unknown) => e);
    expect([error === controller.signal.reason, events]).toEqual([
      true,
      [
        "make-run-dir",
        "trap",
        `mkfifo ${RUN}/token.fifo`,
        "spawn",
        `serve ${RUN}/token.fifo`,
        "serve-stop",
        "kill SIGTERM",
        `remove ${RUN}`,
        "untrap",
      ],
    ]);
  });

  it("cleans up synchronously from the process exit trap, before any await", async () => {
    const events: string[] = [];
    let trap: () => void = () => undefined;
    const { run } = governanceRunner(
      {},
      {},
      {
        spawnWorker: workerUntilKilled(events),
        onTerminate: (cleanup) => {
          trap = cleanup;
          return () => events.push("untrap");
        },
      },
      events,
    );
    const running = run("worker-start", start);
    await vi.waitFor(() => expect(events).toContain("spawn"));
    trap();
    const atExit = [...events];
    const out = await running;
    expect([atExit.slice(-3), out.exitCode, events.slice(-1)]).toEqual([
      ["serve-stop", "kill SIGTERM", `remove ${RUN}`],
      null,
      ["untrap"],
    ]);
  });
});
