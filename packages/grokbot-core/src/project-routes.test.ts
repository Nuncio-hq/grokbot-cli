import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeRemote,
  projectKeys,
  routeForFolder,
} from "./project-routes.js";
import type { ProjectRoute } from "./project-routes-store.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const OTHER = "0a1b2c3d-2222-4222-8222-222222222222";

describe("normalizeRemote", () => {
  it.each([
    "https://github.com/Example-Org/Example-App.git",
    "https://user:token@github.com/example-org/example-app/",
    "git@github.com:example-org/example-app.git",
    "git@github.com:example-org/example-app",
    "ssh://git@github.com/example-org/example-app.git",
    "ssh://git@github.com:22/example-org/example-app",
    "github.com:example-org/example-app.git",
  ])("%s → github.com/example-org/example-app", (url) => {
    expect(normalizeRemote(url)).toBe("github.com/example-org/example-app");
  });

  it("keeps nested groups", () => {
    expect(normalizeRemote("git@gitlab.example:group/sub/app.git")).toBe(
      "gitlab.example/group/sub/app",
    );
  });

  it.each(["", "  ", "/srv/git/app.git", "../app", "just-a-name"])(
    "%j is not a remote",
    (url) => {
      expect(normalizeRemote(url)).toBeUndefined();
    },
  );
});

describe("routeForFolder", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "grokbot-routes-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const route = (agentId: string, label?: string): ProjectRoute => ({
    agentId,
    ...(label !== undefined && { label }),
  });
  const folder = async (...parts: string[]) => {
    const dir = join(root, ...parts);
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  const repo = async (name: string, remote?: string) => {
    const dir = await folder(name);
    git(dir, "init", "-q");
    if (remote) git(dir, "remote", "add", "origin", remote);
    return dir;
  };

  it("finds nothing without routes or without a match", async () => {
    const dir = await folder("app");
    expect(await routeForFolder(new Map(), dir)).toBeUndefined();
    expect(
      await routeForFolder(new Map([[await folder("other"), route(BOT)]]), dir),
    ).toBeUndefined();
  });

  it("matches the folder itself and any subfolder of a path route", async () => {
    const app = await folder("app");
    const deep = await folder("app", "src", "deep");
    const routes = new Map([[app, route(BOT, "App")]]);
    expect(await routeForFolder(routes, app)).toEqual({
      match: app,
      agentId: BOT,
      label: "App",
    });
    expect((await routeForFolder(routes, deep))?.match).toBe(app);
  });

  it("the longest parent path wins", async () => {
    const work = await folder("work");
    const app = await folder("work", "app");
    const deep = await folder("work", "app", "pkg");
    const routes = new Map([
      [work, route(OTHER)],
      [app, route(BOT)],
    ]);
    expect((await routeForFolder(routes, deep))?.agentId).toBe(BOT);
    expect((await routeForFolder(routes, work))?.agentId).toBe(OTHER);
  });

  it("a sibling folder that shares a string prefix does not match", async () => {
    const app = await folder("app");
    const sibling = await folder("app-two");
    const routes = new Map([[app, route(BOT)]]);
    expect(await routeForFolder(routes, sibling)).toBeUndefined();
  });

  it("compares real paths, so a symlink into the project matches", async () => {
    const app = await folder("app");
    const link = join(root, "link");
    await symlink(app, link);
    const routes = new Map([[app, route(BOT)]]);
    expect((await routeForFolder(routes, link))?.agentId).toBe(BOT);
  });

  it("the git remote route beats a path route", async () => {
    const dir = await repo("app", "git@github.com:Example-Org/Example-App.git");
    const routes = new Map([
      [dir, route(OTHER)],
      ["github.com/example-org/example-app", route(BOT, "App")],
    ]);
    expect(await routeForFolder(routes, dir)).toEqual({
      match: "github.com/example-org/example-app",
      agentId: BOT,
      label: "App",
    });
  });

  it("falls back to a path route when the remote has no route, and when there is no remote", async () => {
    const withRemote = await repo("a", "https://github.com/example-org/a.git");
    const noRemote = await repo("b");
    const plain = await folder("c");
    const routes = new Map([
      [withRemote, route(BOT)],
      [noRemote, route(OTHER)],
    ]);
    expect((await routeForFolder(routes, withRemote))?.agentId).toBe(BOT);
    expect((await routeForFolder(routes, noRemote))?.agentId).toBe(OTHER);
    expect(await routeForFolder(routes, plain)).toBeUndefined();
  });

  it("projectKeys reports the normalized remote and the real path", async () => {
    const dir = await repo("app", "ssh://git@github.com/example-org/app.git");
    expect(await projectKeys(dir)).toEqual({
      remote: "github.com/example-org/app",
      path: dir,
    });
    expect(await projectKeys(await folder("plain"))).toEqual({
      path: join(root, "plain"),
    });
  });
});
