import { describe, expect, it } from "vitest";
import { fakeConfig } from "./fixtures/fake-config.js";
import { runCli } from "./fixtures/run-cli.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const TEST_BOT = "0a1b2c3d-2222-4222-8222-222222222222";

describe("grokbot config protect / unprotect", () => {
  it("marks bots, lists them, and stores ids in lowercase", async () => {
    const config = fakeConfig();
    const main = await runCli(
      ["config", "protect", BOT.toUpperCase(), "main"],
      {
        config,
      },
    );
    const test = await runCli(["config", "protect", TEST_BOT, "test"], {
      config,
    });
    expect([main.code, main.stdout, test.stdout]).toEqual([
      0,
      `${BOT} is now protected as main.\n`,
      `${TEST_BOT} is now protected as test.\n`,
    ]);
    const list = await runCli(["config"], { config });
    expect(list.stdout).toContain(
      `protected        ${BOT}  main\n                 ${TEST_BOT}  test\n`,
    );
    const json = await runCli(["config", "--json"], { config });
    expect(JSON.parse(json.stdout).protectedBots).toEqual({
      [BOT]: "main",
      [TEST_BOT]: "test",
    });
  });

  it("changes a role, skips a no-op write, and unprotects", async () => {
    const config = fakeConfig();
    await runCli(["config", "protect", BOT, "test"], { config });
    const same = await runCli(["config", "protect", BOT, "test"], { config });
    const role = await runCli(["config", "protect", BOT, "main", "--json"], {
      config,
    });
    const off = await runCli(["config", "unprotect", BOT], { config });
    const again = await runCli(["config", "unprotect", BOT], { config });
    expect(same.stdout).toBe(`${BOT} is already protected as test.\n`);
    expect(JSON.parse(role.stdout)).toEqual({
      agentId: BOT,
      role: "main",
      changed: true,
    });
    expect([off.stdout, again.stdout]).toEqual([
      `${BOT} is no longer protected.\n`,
      `${BOT} was not protected.\n`,
    ]);
    expect([config.state.bots.size, config.state.botWrites]).toEqual([0, 3]);
  });

  it("keeps the list when another setting changes", async () => {
    const config = fakeConfig();
    await runCli(["config", "protect", BOT, "main"], { config });
    await runCli(["config", "usage", "off"], { config });
    expect([...config.state.bots]).toEqual([[BOT, "main"]]);
  });

  it.each([
    [["config", "protect", BOT], "protect takes <agentId> <main|test>"],
    [["config", "protect", BOT, "boss"], 'the role must be "main" or "test"'],
    [["config", "protect", "Grok Bot", "main"], "is not a full agentId"],
    [["config", "protect", BOT.slice(0, 8), "main"], "is not a full agentId"],
    [["config", "unprotect", BOT, "main"], "unprotect takes <agentId>"],
  ])("%j is a usage error and writes nothing", async (argv, message) => {
    const config = fakeConfig();
    const run = await runCli(argv, { config });
    expect([run.code, config.state.botWrites]).toEqual([2, 0]);
    expect(run.stderr).toContain(message);
  });
});
