import { describe, expect, it } from "vitest";
import { fakeConfig } from "./fixtures/fake-config.js";
import { runCli } from "./fixtures/run-cli.js";

describe("grokbot config", () => {
  it("shows the settings and where they live", async () => {
    const run = await runCli(["config"], {
      config: fakeConfig("silent", "silent"),
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(
      /^keychain-access\s+silent\b.*saved sign-in: silent/m,
    );
    expect(run.stdout).toMatch(/^usage\s+on\b/m);
    expect(run.stdout).toMatch(/^protected\s+none\b/m);
    expect(run.stdout).toMatch(/^routes\s+none\b/m);
    for (const file of [
      "/home/me/.grokbot/grokbot-cli-protected-bots.json",
      "/home/me/.grokbot/grokbot-cli-project-routes.json",
      "/home/me/.grokbot/grokbot-cli.json",
    ]) {
      expect(run.stdout).toContain(file);
    }
  });

  it("reads one setting, with no saved sign-in", async () => {
    const run = await runCli(["config", "keychain-access"], {
      config: fakeConfig(),
    });
    expect(run.stdout).toBe("silent\n");
  });

  it("switches to prompt: saves the setting and re-creates the saved sign-in", async () => {
    const config = fakeConfig("silent", "silent");
    const run = await runCli(["config", "keychain-access", "prompt"], {
      config,
    });
    expect(run.code).toBe(0);
    expect(config.state).toMatchObject({
      access: "prompt",
      item: "prompt",
      switched: ["prompt"],
    });
    expect(run.stdout).toBe(
      "keychain-access is now prompt. The saved sign-in was moved to it.\n",
    );
    expect(run.stderr).toContain(
      "macOS will ask before grokbot reads the sign-in",
    );
    expect(run.stderr).toContain("grokbot-mcp and background agents");
  });

  it("switching with no sign-in saved only stores the setting for the next login", async () => {
    const config = fakeConfig("silent", undefined);
    const run = await runCli(["config", "keychain-access", "prompt"], {
      config,
    });
    expect(config.state.switched).toStrictEqual([]);
    expect(run.stdout).toBe(
      "keychain-access is now prompt. It applies to the next grokbot login.\n",
    );
  });

  it("does not touch the Keychain when the value is unchanged", async () => {
    const config = fakeConfig("silent", "silent");
    const run = await runCli(["config", "keychain-access", "silent"], {
      config,
    });
    expect(config.state.switched).toStrictEqual([]);
    expect(run.stdout).toBe("keychain-access is already silent.\n");
  });

  it("keeps the old setting when the Keychain switch fails", async () => {
    const config = fakeConfig("silent", "silent");
    config.setItemAccess = async () => {
      throw new Error(
        "Cannot switch the grokbot sign-in to prompt access (security exited 1); the previous item was kept.",
      );
    };
    const run = await runCli(["config", "keychain-access", "prompt"], {
      config,
    });
    expect(run.code).toBe(1);
    expect(config.state.access).toBe("silent");
  });

  it.each([
    [
      ["config", "keychain-access", "promt"],
      'grokbot: config: keychain-access must be "silent" or "prompt"',
    ],
    [
      ["config", "colour", "red"],
      'grokbot: config: unknown setting "colour" (known: keychain-access, usage, protect, unprotect, route, unroute)',
    ],
    [
      ["config", "usage", "maybe"],
      'grokbot: config: usage must be "on" or "off"',
    ],
    [
      ["config", "keychain-access", "silent", "extra"],
      "grokbot: config: too many arguments",
    ],
  ])("%j is a usage error", async (argv, message) => {
    const run = await runCli(argv, { config: fakeConfig() });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it("turns the usage log off and on, keeping the Keychain setting", async () => {
    const config = fakeConfig("prompt", "prompt");
    const off = await runCli(["config", "usage", "off"], { config });
    const again = await runCli(["config", "usage", "off"], { config });
    const read = await runCli(["config", "usage"], { config });
    expect([off.stdout, again.stdout, read.stdout]).toEqual([
      "usage is now off. Nothing new is recorded; the saved log stays until you delete ~/.grokbot/usage.\n",
      "usage is already off.\n",
      "off\n",
    ]);
    expect([config.state.access, config.state.writes]).toEqual(["prompt", 1]);
    expect(config.state.switched).toEqual([]);
  });

  it("--json prints one document", async () => {
    const run = await runCli(["config", "--json"], {
      config: fakeConfig("prompt", "prompt"),
    });
    expect(JSON.parse(run.stdout)).toStrictEqual({
      keychainAccess: "prompt",
      usage: "on",
      savedSignIn: "prompt",
      path: "/home/me/.grokbot/grokbot-cli.json",
      protectedBots: {},
      protectedPath: "/home/me/.grokbot/grokbot-cli-protected-bots.json",
      projectRoutes: {},
      projectRoutesPath: "/home/me/.grokbot/grokbot-cli-project-routes.json",
      thisFolderRoute: null,
    });
  });

  it("has help, and is listed under Settings in general help", async () => {
    const help = await runCli(["config", "--help"]);
    expect(help.stdout).toContain("Usage: grokbot config [");
    expect(help.stdout).toContain("route <agentId>");
    const general = await runCli(["--help"]);
    expect(general.stdout).toMatch(/Settings:\n {2}config\s+/);
  });
});
