import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  BOT_SETUP_PROMPT,
  listCommands,
  SETUP_CHECK_PROJECT,
} from "grokbot-core";
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
    expect(terminal.stdout).toBe(piped.stdout);
    expect(terminal.stdout).not.toContain(terminal.stderr.trim());
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
    it("prints the prompt grokbot setup-bots sends, nothing else", async () => {
      const run = await runCli(["setup-prompt", "bot"]);
      expect(run).toMatchObject({ code: 0, stderr: "", calls: [] });
      expect(run.runnerOptions).toEqual([]);
      expect(run.stdout).toBe(`${BOT_SETUP_PROMPT}\n`);
    });

    it("is short enough to paste, and installs or updates grokbot every time", async () => {
      const run = await runCli(["setup-prompt", "bot"]);
      const lines = run.stdout.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(run.stdout).toContain("npm i -g grokbotagent-cli@latest");
      expect(run.stdout).not.toContain("inbox-schema");
    });

    it("names the bot skill through the bot's own npm root, and no path from this computer", async () => {
      const run = await runCli(["setup-prompt", "bot"], {
        setupPrompt: missing("/Users/someone/skills/grokbot/SKILL.md"),
      });
      expect(run.stdout).toContain(
        "$(npm root -g)/grokbotagent-cli/skills/grokbot-inbox/SKILL.md",
      );
      expect(run.stdout).not.toContain("/Users/");
      const skill = new URL(
        "../skills/grokbot-inbox/SKILL.md",
        import.meta.url,
      );
      expect(existsSync(skill)).toBe(true);
    });

    it("names an inbox-post command the CLI accepts, which posts the Setup check item the assistant waits for", async () => {
      const command = /`(grokbot inbox-post [^`]+)`/.exec(
        BOT_SETUP_PROMPT,
      )?.[1];
      expect(command).toBeDefined();
      const argv = [...(command ?? "").matchAll(/"([^"]*)"|(\S+)/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .slice(1);
      const root = await mkdtemp(join(tmpdir(), "grokbot-setup-prompt-"));
      try {
        const run = await runCli(argv, {
          env: {
            GROKBOT_INBOX_ROOT: root,
            CURSOR_CONVERSATION_ID: "0a1b2c3d-1111-4111-8111-111111111111",
            CURSOR_REQUEST_ID: "req-1",
          },
          inboxBot: {
            cwd: root,
            now: () => Date.parse("2026-10-20T10:00:00Z"),
            randomId: () => "setup001",
            readStdin: async () => "",
            readText: async () => "",
            git: async () => undefined,
          },
        });
        expect(run).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(run.stdout)).toMatchObject({
          ok: true,
          project: SETUP_CHECK_PROJECT,
        });
        const [file] = await readdir(join(root, "setup-check", "open"));
        const item = JSON.parse(
          await readFile(join(root, "setup-check", "open", file ?? ""), "utf8"),
        );
        expect(item).toMatchObject({
          kind: "result",
          title: "grokbot inbox works",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
