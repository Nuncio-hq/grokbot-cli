import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliConfigStore } from "./cli-config.js";
import { GrokBotError } from "./contracts.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grokbot-cli-config-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("cliConfigStore", () => {
  it("defaults to silent Keychain access when no config file exists", async () => {
    const store = cliConfigStore(home);
    expect(await store.read()).toStrictEqual({
      keychainAccess: "silent",
      usage: "on",
    });
    expect(store.path).toBe(join(home, ".grokbot", "grokbot-cli.json"));
  });

  it("writes the setting and reads it back", async () => {
    const store = cliConfigStore(home);
    await store.write({ keychainAccess: "prompt", usage: "on" });
    expect(await store.read()).toStrictEqual({
      keychainAccess: "prompt",
      usage: "on",
    });
  });

  it("keeps the file private to this user (0600) and holds no secrets", async () => {
    const store = cliConfigStore(home);
    await store.write({ keychainAccess: "prompt", usage: "on" });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toStrictEqual({
      keychainAccess: "prompt",
      usage: "on",
    });
  });

  it("refuses a misspelled value instead of silently weakening the owner's choice", async () => {
    const store = cliConfigStore(home);
    await store.write({ keychainAccess: "prompt", usage: "on" });
    await writeFile(store.path, '{"keychainAccess":"promt"}');
    await expect(store.read()).rejects.toEqual(
      new GrokBotError(
        "auth",
        `${store.path}: keychainAccess must be "silent" or "prompt". Fix it with grokbot config keychain-access <silent|prompt>.`,
      ),
    );
  });

  it("reads a file saved before the usage setting existed as usage on", async () => {
    const store = cliConfigStore(home);
    await store.write({ keychainAccess: "prompt", usage: "off" });
    await writeFile(store.path, '{"keychainAccess":"prompt"}');
    expect(await store.read()).toStrictEqual({
      keychainAccess: "prompt",
      usage: "on",
    });
  });

  it("refuses a misspelled usage value", async () => {
    const store = cliConfigStore(home);
    await store.write({ keychainAccess: "silent", usage: "on" });
    await writeFile(store.path, '{"keychainAccess":"silent","usage":"of"}');
    await expect(store.read()).rejects.toEqual(
      new GrokBotError(
        "auth",
        `${store.path}: usage must be "on" or "off". Fix it with grokbot config usage <on|off>.`,
      ),
    );
  });

  it("refuses a file that is not JSON", async () => {
    const store = cliConfigStore(home);
    await store.write({ keychainAccess: "silent", usage: "on" });
    await writeFile(store.path, "{ nope");
    await expect(store.read()).rejects.toBeInstanceOf(GrokBotError);
  });
});
