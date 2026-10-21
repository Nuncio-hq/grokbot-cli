import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpsRemote, inboxGitInfo } from "./inbox-git.js";

describe("httpsRemote", () => {
  it.each([
    "https://github.com/Example-Org/Example-App.git",
    "https://user:token@github.com/Example-Org/Example-App/",
    "git@github.com:Example-Org/Example-App.git",
    "git@github.com:Example-Org/Example-App",
    "ssh://git@github.com/Example-Org/Example-App.git",
    "ssh://git@github.com:22/Example-Org/Example-App",
    "git://github.com/Example-Org/Example-App.git",
  ])("%s → https://github.com/Example-Org/Example-App", (url) => {
    expect(httpsRemote(url)).toBe("https://github.com/Example-Org/Example-App");
  });

  it("keeps nested paths", () => {
    expect(httpsRemote("git@gitlab.example:group/sub/app.git")).toBe(
      "https://gitlab.example/group/sub/app",
    );
  });

  it.each(["", "  ", "/srv/git/app.git", "../app", "just-a-name"])(
    "gives nothing for %j",
    (url) => {
      expect(httpsRemote(url)).toBeUndefined();
    },
  );

  it("never carries credentials", () => {
    expect(
      httpsRemote("https://user:secret@example.com/o/r.git"),
    ).not.toContain("secret");
  });
});

describe("inboxGitInfo", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grokbot-inbox-git-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

  it("is undefined outside a checkout", async () => {
    expect(await inboxGitInfo(dir)).toBeUndefined();
  });

  it("gives origin, branch and commit of a checkout", async () => {
    git("init", "-q", "-b", "work");
    git(
      "remote",
      "add",
      "origin",
      "git@github.com:Example-Org/Example-App.git",
    );
    git("commit", "-q", "--allow-empty", "-m", "first");
    expect(await inboxGitInfo(dir)).toEqual({
      url: "https://github.com/Example-Org/Example-App",
      branch: "work",
      commit: git("rev-parse", "HEAD"),
    });
  });

  it("leaves out what is missing: no remote, no commit yet, a detached head", async () => {
    git("init", "-q", "-b", "work");
    expect(await inboxGitInfo(dir)).toEqual({ branch: "work" });
    git("commit", "-q", "--allow-empty", "-m", "first");
    expect(await inboxGitInfo(dir)).toEqual({
      branch: "work",
      commit: git("rev-parse", "HEAD"),
    });
    git("checkout", "-q", "--detach");
    expect(await inboxGitInfo(dir)).toEqual({
      commit: git("rev-parse", "HEAD"),
    });
  });
});
