import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { listCommands } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { runCli } from "./fixtures/run-cli.js";
import type { SetupPromptDeps } from "./setup-prompt-command.js";

const SKILL_PATH = /(\S+SKILL\.md)/;

const missing = (skillPath: string): SetupPromptDeps => ({
  skillPath,
  exists: async () => false,
});

describe("grokbot setup-prompt", () => {
  it("prints a prompt naming the shipped skill by an absolute path that exists", async () => {
    const run = await runCli(["setup-prompt"]);
    expect(run).toMatchObject({ code: 0, stderr: "", calls: [] });
    expect(run.runnerOptions).toEqual([]);
    const path = SKILL_PATH.exec(run.stdout)?.[1] ?? "";
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("is short enough to paste", async () => {
    const run = await runCli(["setup-prompt"]);
    const lines = run.stdout.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("names the npm-root form when the skill is not where the module is", async () => {
    const run = await runCli(["setup-prompt"], {
      setupPrompt: missing("/nowhere/skills/grokbot/SKILL.md"),
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      "<npm root -g>/grokbotagent-cli/skills/grokbot/SKILL.md",
    );
    expect(run.stdout).not.toContain("/nowhere/");
  });

  it("prints the one-line hint on stderr only when stderr is a terminal", async () => {
    const piped = await runCli(["setup-prompt"], { isTTY: false });
    const terminal = await runCli(["setup-prompt"], { isTTY: true });
    expect(piped.stderr).toBe("");
    expect(terminal.stderr.trim().split("\n")).toHaveLength(1);
    expect(terminal.stderr).toContain("Paste this into your agent.");
    expect(terminal.stdout).toBe(piped.stdout);
    expect(terminal.stdout).not.toContain("Paste this into your agent.");
  });

  it("has its own help, is listed in general help and is not a catalog command", async () => {
    const help = await runCli(["setup-prompt", "--help"]);
    expect(help).toMatchObject({ code: 0, stderr: "" });
    expect(help.stdout).toContain("grokbot setup-prompt");
    const general = await runCli(["--help"]);
    expect(general.stdout).toMatch(/^ {2}setup-prompt\s+\S/m);
    expect(listCommands().map((c) => c.name)).not.toContain("setup-prompt");
  });

  it("rejects unknown and extra arguments", async () => {
    for (const argv of [
      ["setup-prompt", "--bogus"],
      ["setup-prompt", "bots"],
      ["setup-prompt", "bot", "extra"],
    ]) {
      const run = await runCli(argv);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Usage: grokbot setup-prompt");
    }
  });

  it("prints the same assistant prompt with or without the word assistant", async () => {
    const plain = await runCli(["setup-prompt"]);
    const named = await runCli(["setup-prompt", "assistant"]);
    expect(named.code).toBe(0);
    expect(named.stdout).toBe(plain.stdout);
  });

  describe("bot", () => {
    it("prints a pasteable prompt that installs grokbot and the bot skill on the cloud computer", async () => {
      const run = await runCli(["setup-prompt", "bot"]);
      expect(run).toMatchObject({ code: 0, stderr: "", calls: [] });
      expect(run.runnerOptions).toEqual([]);
      expect(run.stdout).toContain("npm i -g grokbotagent-cli@latest");
      expect(run.stdout).toContain(
        "$(npm root -g)/grokbotagent-cli/skills/grokbot-inbox/SKILL.md",
      );
      const lines = run.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeLessThanOrEqual(10);
    });

    it("names no path from this computer, since the bot runs it on its own", async () => {
      const run = await runCli(["setup-prompt", "bot"], {
        setupPrompt: missing("/Users/someone/skills/grokbot/SKILL.md"),
      });
      expect(run.stdout).not.toContain("/Users/");
    });

    it("names the shipped bot skill, which exists in this package", () => {
      const skill = new URL(
        "../skills/grokbot-inbox/SKILL.md",
        import.meta.url,
      );
      expect(existsSync(skill)).toBe(true);
    });
  });
});
