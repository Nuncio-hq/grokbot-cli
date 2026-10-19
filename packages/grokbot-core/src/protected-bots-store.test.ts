import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { protectedBotsStore } from "./protected-bots-store.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const TEST_BOT = "0a1b2c3d-2222-4222-8222-222222222222";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grokbot-protected-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const store = () => protectedBotsStore(home);
const writeRaw = async (text: string) => {
  await mkdir(join(home, ".grokbot"), { recursive: true });
  await writeFile(store().path, text);
};

describe("protectedBotsStore", () => {
  it("reads as empty when the file does not exist", async () => {
    expect((await store().read()).size).toBe(0);
  });

  it("round-trips the list in a 0600 file, ids sorted", async () => {
    await store().write(
      new Map([
        [TEST_BOT, "test"],
        [BOT, "main"],
      ]),
    );
    expect([...(await store().read())]).toEqual([
      [BOT, "main"],
      [TEST_BOT, "test"],
    ]);
    expect(JSON.parse(await readFile(store().path, "utf8"))).toEqual({
      [BOT]: "main",
      [TEST_BOT]: "test",
    });
    expect((await stat(store().path)).mode & 0o777).toBe(0o600);
  });

  it("lowercases ids written by hand", async () => {
    await writeRaw(JSON.stringify({ [BOT.toUpperCase()]: "main" }));
    expect([...(await store().read())]).toEqual([[BOT, "main"]]);
  });

  it.each([
    ["not JSON", "{", "is not valid JSON"],
    ["an array", `["${BOT}"]`, "must be an object"],
    ["a name for a key", '{"Grok Bot": "main"}', "is not a full agentId"],
    ["an unknown role", `{"${BOT}": "boss"}`, 'must be "main" or "test"'],
  ])("fails closed on %s", async (_label, text, message) => {
    await writeRaw(text);
    const error = await store()
      .read()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).code).toBe("safety");
    expect((error as GrokBotError).message).toContain(message);
  });
});
