import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeConfig } from "./fixtures/fake-config.js";
import { runCli } from "./fixtures/run-cli.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const OTHER = "0a1b2c3d-2222-4222-8222-222222222222";
const REMOTE = "github.com/example-org/example-app";

let root: string;
let plain: string;
let repo: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "grokbot-route-cli-")));
  plain = join(root, "plain");
  repo = join(root, "repo");
  await mkdir(plain);
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Example-Org/Example-App.git"],
    { cwd: repo },
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const configIn = (cwd: string) => fakeConfig("silent", undefined, cwd);

describe("grokbot config route / unroute", () => {
  it("keys a repo's route by its normalized git remote", async () => {
    const config = configIn(repo);
    const run = await runCli(
      ["config", "route", BOT.toUpperCase(), "--label", "ProjectName"],
      { config },
    );
    expect([run.code, run.stdout]).toEqual([
      0,
      `${REMOTE} now goes to ${BOT} as [ProjectName].\n`,
    ]);
    expect([...config.state.routes]).toEqual([
      [REMOTE, { agentId: BOT, label: "ProjectName" }],
    ]);
  });

  it("keys a folder with no remote by its absolute path", async () => {
    const config = configIn(plain);
    await runCli(["config", "route", BOT], { config });
    expect([...config.state.routes]).toEqual([[plain, { agentId: BOT }]]);
  });

  it("--path keys a repo by its folder, next to a remote route", async () => {
    const config = configIn(repo);
    await runCli(["config", "route", BOT], { config });
    await runCli(["config", "route", OTHER, "--path"], { config });
    expect([...config.state.routes]).toEqual([
      [REMOTE, { agentId: BOT }],
      [repo, { agentId: OTHER }],
    ]);
  });

  it("replaces a route, skips a no-op write, and reports --json", async () => {
    const config = configIn(plain);
    await runCli(["config", "route", BOT], { config });
    const same = await runCli(["config", "route", BOT], { config });
    const changed = await runCli(
      ["config", "route", OTHER, "--label=Docs", "--json"],
      { config },
    );
    expect(same.stdout).toBe(`${plain} already goes to ${BOT}.\n`);
    expect(JSON.parse(changed.stdout)).toEqual({
      match: plain,
      route: { agentId: OTHER, label: "Docs" },
      changed: true,
    });
    expect([...config.state.routes]).toEqual([
      [plain, { agentId: OTHER, label: "Docs" }],
    ]);
    expect(config.state.routeWrites).toBe(2);
  });

  it("unroute removes this folder's route by the same keying, and says when there was none", async () => {
    const config = configIn(repo);
    await runCli(["config", "route", BOT], { config });
    await runCli(["config", "route", OTHER, "--path"], { config });
    const none = await runCli(["config", "unroute", "--path"], {
      config: configIn(plain),
    });
    const remote = await runCli(["config", "unroute"], { config });
    const again = await runCli(["config", "unroute"], { config });
    const byPath = await runCli(["config", "unroute", "--path"], { config });
    expect(none.stdout).toBe(`No route for ${plain}.\n`);
    expect([remote.stdout, again.stdout, byPath.stdout]).toEqual([
      `Removed the route for ${REMOTE}.\n`,
      `No route for ${REMOTE}.\n`,
      `Removed the route for ${repo}.\n`,
    ]);
    expect(config.state.routes.size).toBe(0);
  });

  it("config lists the routes and marks the one this folder uses", async () => {
    const config = configIn(repo);
    await runCli(["config", "route", BOT, "--label", "ProjectName"], {
      config,
    });
    config.state.routes.set("/elsewhere", { agentId: OTHER });
    const list = await runCli(["config"], { config });
    expect(list.stdout).toContain(
      `routes           ${REMOTE}  ${BOT}  [ProjectName]  <- this folder\n                 /elsewhere  ${OTHER}\n`,
    );
    expect(list.stdout).toContain(
      "Project routes file: /home/me/.grokbot/grokbot-cli-project-routes.json",
    );
    const json = JSON.parse(
      (await runCli(["config", "--json"], { config })).stdout,
    );
    expect(json.projectRoutes).toEqual({
      [REMOTE]: { agentId: BOT, label: "ProjectName" },
      "/elsewhere": { agentId: OTHER },
    });
    expect(json.thisFolderRoute).toEqual({
      match: REMOTE,
      agentId: BOT,
      label: "ProjectName",
    });
  });

  it.each([
    [["config", "route"], "route takes <agentId>"],
    [["config", "route", BOT, OTHER], "route takes <agentId>"],
    [["config", "route", "Grok Bot"], "is not a full agentId"],
    [["config", "route", BOT.slice(0, 8)], "is not a full agentId"],
    [["config", "route", BOT, "--label"], "--label needs a non-empty text"],
    [
      ["config", "route", BOT, "--label", " "],
      "--label needs a non-empty text",
    ],
    [["config", "route", BOT, "--colour"], 'unknown flag "--colour"'],
    [["config", "unroute", BOT], "unroute takes no arguments"],
    [["config", "unroute", "--label", "X"], "unroute takes no arguments"],
  ])("%j is a usage error and writes nothing", async (argv, message) => {
    const config = configIn(plain);
    const run = await runCli(argv, { config });
    expect([run.code, config.state.routeWrites]).toEqual([2, 0]);
    expect(run.stderr).toContain(message);
  });
});
