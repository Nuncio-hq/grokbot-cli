import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  type LocalApprovalsStore,
  localApprovalsStore,
  recordLocalApproval,
  undoLocalApproval,
} from "./governance-local-approvals.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grokbot-approvals-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const store = (scope: string | undefined): LocalApprovalsStore => ({
  path: join(home, ".grokbot", "local-tool-approvals.json"),
  readActiveAccountScope: async () => scope,
});
const readFileJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

describe("recordLocalApproval", () => {
  it("writes the daemon's { approvals: [...] } shape with the active account scope", async () => {
    const s = store("scope-abc");
    const write = await recordLocalApproval(s, {
      id: "a".repeat(64),
      action: "run-command",
      target: "ls -la",
    });
    expect(write).toEqual({
      entry: {
        id: "a".repeat(64),
        action: "run-command",
        target: "ls -la",
        accountScope: "scope-abc",
      },
      previous: undefined,
    });
    expect(await readFileJson(s.path)).toEqual({
      approvals: [
        {
          id: "a".repeat(64),
          action: "run-command",
          target: "ls -la",
          accountScope: "scope-abc",
        },
      ],
    });
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
  });

  it("omits accountScope when settings has none, like the desktop app", async () => {
    const s = store(undefined);
    await recordLocalApproval(s, {
      id: "r1",
      action: "read-file",
      target: "/x",
    });
    expect(await readFileJson(s.path)).toEqual({
      approvals: [{ id: "r1", action: "read-file", target: "/x" }],
    });
  });

  it("keeps other entries and replaces the same id, so a retry converges", async () => {
    const s = store("scope");
    await recordLocalApproval(s, {
      id: "r1",
      action: "run-command",
      target: "a",
    });
    await recordLocalApproval(s, {
      id: "r2",
      action: "run-command",
      target: "b",
    });
    await recordLocalApproval(s, {
      id: "r1",
      action: "run-command",
      target: "a",
    });
    expect(await readFileJson(s.path)).toEqual({
      approvals: [
        { id: "r1", action: "run-command", target: "a", accountScope: "scope" },
        { id: "r2", action: "run-command", target: "b", accountScope: "scope" },
      ],
    });
  });

  it("keeps fields it does not know, like the app's resourcePath, and drops malformed rows", async () => {
    const s = store(undefined);
    await recordLocalApproval(s, {
      id: "seed",
      action: "run-command",
      target: "x",
    });
    const app = {
      id: "ok",
      action: "read-file",
      target: "y",
      resourcePath: "/Users/owner/y",
      accountScope: "s",
    };
    await writeFile(
      s.path,
      JSON.stringify({ approvals: [app, { id: 5 }, "junk"] }),
    );
    await recordLocalApproval(s, {
      id: "new",
      action: "run-command",
      target: "z",
    });
    expect(await readFileJson(s.path)).toEqual({
      approvals: [app, { id: "new", action: "run-command", target: "z" }],
    });
  });

  it("refuses to rewrite a file it cannot parse, leaving it as it was", async () => {
    const s = store(undefined);
    await recordLocalApproval(s, {
      id: "seed",
      action: "run-command",
      target: "x",
    });
    await writeFile(s.path, "{ not json");
    const error = await recordLocalApproval(s, {
      id: "after",
      action: "run-command",
      target: "w",
    }).catch((e: unknown) => e);
    expect([
      error instanceof GrokBotError ? [error.code, error.message] : error,
      await readFile(s.path, "utf8"),
    ]).toEqual([
      [
        "protocol",
        `${s.path} is not valid JSON, so grokbot will not rewrite it. Fix or remove it, then retry.`,
      ],
      "{ not json",
    ]);
  });
});

describe("undoLocalApproval", () => {
  it("removes a new id, restores a replaced row whole, and keeps the rest", async () => {
    const s = store("scope");
    const app = {
      id: "app",
      action: "read-file",
      target: "/y",
      resourcePath: "/y",
    };
    const other = { id: "other", action: "run-command", target: "b" };
    await recordLocalApproval(s, {
      id: "seed",
      action: "run-command",
      target: "c",
    });
    await writeFile(s.path, JSON.stringify({ approvals: [app, other] }));
    const added = await recordLocalApproval(s, {
      id: "r1",
      action: "run-command",
      target: "a",
    });
    const replaced = await recordLocalApproval(s, {
      id: "app",
      action: "read-file",
      target: "/y",
    });
    await undoLocalApproval(s, replaced);
    await undoLocalApproval(s, added);
    expect([replaced.previous, await readFileJson(s.path)]).toEqual([
      app,
      { approvals: [app, other] },
    ]);
  });
});

describe("localApprovalsStore", () => {
  it("reads activeAccountScope from ~/.grokbot/settings.json under the given home", async () => {
    const dir = join(home, ".grokbot");
    await recordLocalApproval(
      {
        path: join(dir, "probe.json"),
        readActiveAccountScope: async () => undefined,
      },
      { id: "p", action: "run-command", target: "t" },
    );
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ activeAccountScope: "live-scope", other: 1 }),
    );
    const s = localApprovalsStore(home);
    expect([s.path, await s.readActiveAccountScope()]).toEqual([
      join(home, ".grokbot", "local-tool-approvals.json"),
      "live-scope",
    ]);
  });

  it("returns undefined when settings.json is missing or broken", async () => {
    const missing = await localApprovalsStore(home).readActiveAccountScope();
    const dir = join(home, ".grokbot");
    await recordLocalApproval(
      {
        path: join(dir, "probe.json"),
        readActiveAccountScope: async () => undefined,
      },
      { id: "p", action: "run-command", target: "t" },
    );
    await writeFile(join(dir, "settings.json"), "nope");
    const broken = await localApprovalsStore(home).readActiveAccountScope();
    expect([missing, broken]).toEqual([undefined, undefined]);
  });
});
