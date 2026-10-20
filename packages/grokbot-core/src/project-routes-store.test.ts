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
import { projectRoutesStore } from "./project-routes-store.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const REMOTE = "github.com/example-org/example-app";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grokbot-routes-store-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const store = () => projectRoutesStore(home);
const writeRaw = async (text: string) => {
  await mkdir(join(home, ".grokbot"), { recursive: true });
  await writeFile(store().path, text);
};

describe("projectRoutesStore", () => {
  it("reads as empty when the file does not exist", async () => {
    expect((await store().read()).size).toBe(0);
  });

  it("round-trips routes in a 0600 file inside a 0700 folder, keys sorted", async () => {
    await store().write(
      new Map([
        ["/work/app", { agentId: BOT }],
        [REMOTE, { agentId: BOT, label: "ProjectName" }],
      ]),
    );
    expect([...(await store().read())]).toEqual([
      ["/work/app", { agentId: BOT }],
      [REMOTE, { agentId: BOT, label: "ProjectName" }],
    ]);
    expect(JSON.parse(await readFile(store().path, "utf8"))).toEqual({
      "/work/app": { agentId: BOT },
      [REMOTE]: { agentId: BOT, label: "ProjectName" },
    });
    expect((await stat(store().path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".grokbot"))).mode & 0o777).toBe(0o700);
  });

  it("lowercases hand-written ids and remotes", async () => {
    await writeRaw(
      JSON.stringify({
        "GitHub.com/Example-Org/Example-App": { agentId: BOT.toUpperCase() },
      }),
    );
    expect([...(await store().read())]).toEqual([[REMOTE, { agentId: BOT }]]);
  });

  it.each([
    ["not JSON", "{", "is not valid JSON"],
    ["an array", "[]", "must be an object"],
    [
      "a bare name for a key",
      `{"app": {"agentId": "${BOT}"}}`,
      "neither an absolute",
    ],
    ["a string route", `{"${REMOTE}": "${BOT}"}`, "must be an object"],
    [
      "a short agentId",
      `{"${REMOTE}": {"agentId": "${BOT.slice(0, 8)}"}}`,
      "is not a full agentId",
    ],
    [
      "a blank label",
      `{"${REMOTE}": {"agentId": "${BOT}", "label": " "}}`,
      "non-empty string",
    ],
  ])("fails closed on %s, with a fix hint", async (_label, text, message) => {
    await writeRaw(text);
    const error = await store()
      .read()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).toContain(message);
    expect((error as GrokBotError).message).toContain(
      "Fix or delete the file, then add routes again with grokbot config route.",
    );
  });

  it("fails closed when the path is not a readable file", async () => {
    await mkdir(store().path, { recursive: true });
    await expect(store().read()).rejects.toThrow("cannot be read");
  });
});
