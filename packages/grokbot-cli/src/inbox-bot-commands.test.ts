import type * as ChildProcess from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOX_ITEM_JSON_SCHEMA,
  INBOX_OUTCOMES,
  type InboxItem,
  listCommands,
} from "grokbot-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./fixtures/run-cli.js";
import { INBOX_BOT_COMMANDS, type InboxBotDeps } from "./inbox-bot-commands.js";
import { runLocal } from "./local-commands.js";

/** Every program the code under test starts, recorded while the real one still runs. */
const spawned = vi.hoisted((): string[] => []);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const execFile = Object.assign(
    (file: string, ...rest: unknown[]) => {
      spawned.push(file);
      return (real.execFile as (...args: unknown[]) => unknown)(file, ...rest);
    },
    {
      [custom]: (file: string, ...rest: unknown[]) => {
        spawned.push(file);
        const promisified = (
          real.execFile as unknown as Record<
            symbol,
            (...args: unknown[]) => unknown
          >
        )[custom];
        return promisified?.(file, ...rest);
      },
    },
  );
  return {
    ...real,
    execFile,
    spawn: (file: string, ...rest: unknown[]) => {
      spawned.push(file);
      return (real.spawn as (...args: unknown[]) => unknown)(file, ...rest);
    },
  };
});

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const OTHER_BOT = "0a1b2c3d-2222-4222-8222-222222222222";
const DAY = 86_400_000;
const GIT = {
  url: "https://github.com/example-org/example-app",
  branch: "main",
  commit: "710511cf814b99dea915f6ddfd3f955e84db469e",
};

let dir: string;
let root: string;
let now: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-inbox-cli-"));
  root = join(dir, "inbox");
  now = Date.parse("2026-10-20T10:00:00Z");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const botEnv = (extra: Record<string, string> = {}) => ({
  GROKBOT_INBOX_ROOT: root,
  CURSOR_CONVERSATION_ID: BOT,
  CURSOR_REQUEST_ID: "req-1",
  ...extra,
});

interface Setup {
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly git?: InboxBotDeps["git"];
}

function exec(argv: string[], setup: Setup = {}) {
  const stdinReads: number[] = [];
  const gitCalls: string[] = [];
  const result = runCli(argv, {
    env: setup.env ?? botEnv(),
    inboxBot: {
      cwd: dir,
      now: () => now,
      randomId: (() => {
        let n = 0;
        return () => `id${String(++n).padStart(6, "0")}`;
      })(),
      readStdin: async () => {
        stdinReads.push(1);
        return setup.stdin ?? "";
      },
      readText: (path) => readFile(path, "utf8"),
      git:
        setup.git ??
        (async (cwd) => {
          gitCalls.push(cwd);
          return GIT;
        }),
    },
  });
  return result.then((run) => ({
    ...run,
    stdinReads: stdinReads.length,
    gitCalls,
  }));
}

const out = (run: { stdout: string }) => JSON.parse(run.stdout);
const post = (...flags: string[]) => ["inbox-post", ...flags];
const BUG = [
  "--project",
  "Demo App",
  "--kind",
  "bug",
  "--title",
  "Login fails",
  "--done-when",
  "Login works",
];
const open = async () => {
  try {
    return (await readdir(join(root, "demo-app", "open"))).sort();
  } catch {
    return [];
  }
};
const item = async (state: "open" | "closed", slug = "demo-app") => {
  const [name] = (await readdir(join(root, slug, state))).sort();
  return JSON.parse(
    await readFile(join(root, slug, state, name ?? ""), "utf8"),
  ) as InboxItem;
};

describe("grokbot inbox-post with flags", () => {
  it("writes the item and prints the result as JSON", async () => {
    const run = await exec(
      post(...BUG, "--severity", "high", "--start-here", "bun test"),
    );
    expect(run).toMatchObject({
      code: 0,
      stderr: "",
      calls: [],
      runnerOptions: [],
    });
    const result = out(run);
    expect(Object.keys(result)).toEqual([
      "ok",
      "id",
      "project",
      "slug",
      "path",
      "deduped",
      "openInProject",
      "expired",
    ]);
    expect(result).toMatchObject({
      ok: true,
      id: "id000001",
      project: "Demo App",
      slug: "demo-app",
      path: join(
        root,
        "demo-app",
        "open",
        "20261020T100000Z_bug_id000001.json",
      ),
      deduped: false,
      openInProject: 1,
      expired: [],
    });
    const saved = await item("open");
    expect(saved).toMatchObject({
      schema: "grokbot.inbox.item/v1",
      severity: "high",
      startHere: "bun test",
      ask: { doneWhen: "Login works" },
      from: { agentId: BOT, run: "req-1", cwd: dir, git: GIT },
      status: "open",
    });
    expect(run.gitCalls).toEqual([dir]);
  });

  it("takes every flag", async () => {
    const attached = join(dir, "run.log");
    await writeFile(attached, "output\n");
    const run = await exec(
      post(
        "--project=Demo App",
        "--kind",
        "question",
        "--title",
        "Which database?",
        "--choice",
        "sqlite",
        "--choice",
        "postgres",
        "--reply",
        "Pick one",
        "--blocking",
        "the schema",
        "--verify",
        "bun test",
        "--summary",
        "We must choose.",
        "--ref",
        "doc=https://example.com/a?b=c",
        "--ref",
        "log=https://example.com/log",
        "--file",
        "run.log",
        "--dedupe-key",
        "db",
        "--relates-to",
        "abcd1234",
        "--relates-to",
        "efgh5678",
        "--reply-to",
        OTHER_BOT,
        "--to-session",
        "omp:abcd1234",
        "--expires-in",
        "6h",
      ),
    );
    expect(run.code).toBe(0);
    expect(await item("open")).toMatchObject({
      kind: "question",
      ask: {
        choices: ["sqlite", "postgres"],
        reply: "Pick one",
        blocking: "the schema",
        verify: "bun test",
      },
      details: { summary: "We must choose." },
      refs: [
        { label: "doc", url: "https://example.com/a?b=c" },
        { label: "log", url: "https://example.com/log" },
      ],
      files: [
        { name: "run.log", path: "files/id000001/run.log", sizeBytes: 7 },
      ],
      dedupeKey: "db",
      relatesTo: ["abcd1234", "efgh5678"],
      replyTo: { agentId: OTHER_BOT },
      to: { session: "omp:abcd1234" },
      expiresAt: "2026-10-20T16:00:00Z",
    });
  });

  it("reads the details from a file or stdin, and flag values that start with a dash", async () => {
    await writeFile(join(dir, "body.md"), "From a file.\n");
    expect((await exec(post(...BUG, "--body-file", "body.md"))).code).toBe(0);
    expect((await item("open")).details?.summary).toBe("From a file.");
    await rm(root, { recursive: true });
    const run = await exec(
      post(
        ...BUG.slice(0, 4),
        "--title",
        "-5 is wrong",
        "--done-when",
        "x",
        "--body-file",
        "-",
      ),
      {
        stdin: "From stdin.\n",
      },
    );
    expect(run.code).toBe(0);
    expect(await item("open")).toMatchObject({
      title: "-5 is wrong",
      details: { summary: "From stdin." },
    });
  });

  it("dedupes: the same dedupeKey updates the open item", async () => {
    const first = out(await exec(post(...BUG, "--dedupe-key", "login")));
    now += 3_600_000;
    const second = out(
      await exec(post(...BUG, "--dedupe-key", "login", "--summary", "Again."), {
        env: botEnv({ CURSOR_REQUEST_ID: "req-2" }),
      }),
    );
    expect(second).toMatchObject({
      deduped: true,
      id: first.id,
      openInProject: 1,
    });
    expect(await open()).toHaveLength(1);
    expect((await item("open")).updates).toEqual([
      { at: "2026-10-20T11:00:00Z", run: "req-2", note: "re-posted" },
    ]);
  });

  it("refuses with exit 2, JSON errors with exact paths, one stderr line and no file", async () => {
    const run = await exec(post("--project", "Demo App", "--kind", "story"));
    expect(run.code).toBe(2);
    expect(out(run).ok).toBe(false);
    expect(
      out(run)
        .errors.map((e: { path: string }) => e.path)
        .sort(),
    ).toEqual(["kind", "title"]);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("kind");
    expect(await stat(root).catch(() => undefined)).toBeUndefined();
  });

  it("names the flag beside a validation problem", async () => {
    const run = await exec(
      post("--project", "Demo App", "--kind", "bug", "--title", "x"),
    );
    const [error] = out(run).errors;
    expect(error.path).toBe("ask.doneWhen");
    expect(error.message).toContain("--done-when");
  });

  it("addresses the item to a session with --to-session, or `to` in a JSON draft", async () => {
    const address = "omp:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(
      (await exec(post(...BUG, "--to-session", ` ${address} `))).code,
    ).toBe(0);
    expect((await item("open")).to).toEqual({ session: address });
    await rm(root, { recursive: true });
    const viaJson = await exec(post("--json", "-"), {
      stdin: JSON.stringify({
        project: "Demo App",
        kind: "result",
        title: "Done",
        to: { session: address },
      }),
    });
    expect(viaJson.code).toBe(0);
    expect((await item("open")).to).toEqual({ session: address });
  });

  it("refuses a malformed --to-session and names the flag", async () => {
    const run = await exec(post(...BUG, "--to-session", "0190a1b2-c3d4"));
    expect(run.code).toBe(2);
    const [error] = out(run).errors;
    expect(error.path).toBe("to.session");
    expect(error.message).toContain("--to-session");
    expect(await stat(root).catch(() => undefined)).toBeUndefined();
  });

  it("addresses the item to one job with --re-job, lower-cased, alone or with --to-session", async () => {
    expect((await exec(post(...BUG, "--re-job", " 1F2E3D4C "))).code).toBe(0);
    expect((await item("open")).to).toEqual({ job: "1f2e3d4c" });
    await rm(root, { recursive: true });
    const address = "omp:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(
      (
        await exec(
          post(...BUG, "--to-session", address, "--re-job", "1f2e3d4c"),
        )
      ).code,
    ).toBe(0);
    expect((await item("open")).to).toEqual({
      session: address,
      job: "1f2e3d4c",
    });
  });

  it("takes `to {job}` in a JSON draft and refuses an empty `to`", async () => {
    const draft = { project: "Demo App", kind: "result", title: "Done" };
    const viaJson = await exec(post("--json", "-"), {
      stdin: JSON.stringify({ ...draft, to: { job: "1f2e3d4c" } }),
    });
    expect(viaJson.code).toBe(0);
    expect((await item("open")).to).toEqual({ job: "1f2e3d4c" });
    const empty = await exec(post("--json", "-"), {
      stdin: JSON.stringify({ ...draft, to: {} }),
    });
    expect(empty.code).toBe(2);
    expect(out(empty).errors[0].path).toBe("to");
  });

  it("refuses a malformed --re-job and names the flag", async () => {
    const run = await exec(post(...BUG, "--re-job", "not-a-job"));
    expect(run.code).toBe(2);
    const [error] = out(run).errors;
    expect(error.path).toBe("to.job");
    expect(error.message).toContain("--re-job");
  });

  it("does not combine --re-job with --json", async () => {
    const run = await exec(post("--json", "-", "--re-job", "1f2e3d4c"), {
      stdin: JSON.stringify({
        project: "Demo App",
        kind: "result",
        title: "t",
      }),
    });
    expect(run.code).toBe(2);
    expect(out(run).errors[0].path).toBe("--re-job");
  });

  it("lists the allowed values of an unknown kind", async () => {
    const run = await exec(
      post("--project", "P", "--kind", "story", "--title", "t"),
    );
    for (const kind of ["bug", "task", "question", "result", "decision"])
      expect(out(run).errors[0].message).toContain(kind);
  });

  it.each([
    ["an unknown flag", [...BUG, "--bogus", "1"], "--bogus"],
    ["a flag without a value", [...BUG, "--severity"], "--severity"],
    ["a repeated single flag", [...BUG, "--title", "again"], "--title"],
    ["a stray argument", [...BUG, "extra"], "extra"],
    ["a malformed --ref", [...BUG, "--ref", "no-equals"], "--ref"],
    ["a bad --expires-in", [...BUG, "--expires-in", "5m"], "--expires-in"],
    [
      "--summary with --body-file",
      [...BUG, "--summary", "a", "--body-file", "-"],
      "--body-file",
    ],
  ])("refuses %s at %s", async (_, argv, path) => {
    const run = await exec(post(...argv), { stdin: "text" });
    expect(run.code).toBe(2);
    expect(out(run).errors.map((e: { path: string }) => e.path)).toContain(
      path,
    );
    expect(await open()).toEqual([]);
  });

  it("refuses a credential and names the field, while commit SHAs pass", async () => {
    const token = `${"ghp"}_${"a1b2c3d4e5".repeat(4)}`;
    const refused = await exec(post(...BUG, "--summary", `token ${token}`));
    expect(refused.code).toBe(2);
    expect(out(refused).errors[0].path).toBe("details.summary");
    expect(refused.stdout).not.toContain(token);
    expect(refused.stderr).not.toContain(token);
    expect(await open()).toEqual([]);
    const fine = await exec(
      post(...BUG, "--summary", `fixed in ${GIT.commit}`),
    );
    expect(fine.code).toBe(0);
  });
});

describe("grokbot inbox-post from the environment", () => {
  it.each(["CURSOR_CONVERSATION_ID", "CURSOR_REQUEST_ID"])(
    "refuses with exit 2 when %s is missing, before reading anything",
    async (name) => {
      const env = botEnv();
      delete (env as Record<string, string | undefined>)[name];
      const run = await exec(post("--json", "-"), { env, stdin: "{}" });
      expect(run.code).toBe(2);
      expect(out(run).errors[0].path).toBe(`env.${name}`);
      expect(out(run).errors[0].message).toContain("GrokBot bot");
      expect(run.stdinReads).toBe(0);
      expect(run.gitCalls).toEqual([]);
      expect(await stat(root).catch(() => undefined)).toBeUndefined();
    },
  );

  it("treats a blank id as missing", async () => {
    const run = await exec(post(...BUG), {
      env: botEnv({ CURSOR_REQUEST_ID: "  " }),
    });
    expect(run.code).toBe(2);
  });

  it("uses GROKBOT_INBOX_ROOT, else the default root", async () => {
    expect((await exec(post(...BUG))).code).toBe(0);
    expect((await readdir(root)).sort()).toEqual(["demo-app"]);
  });

  it("stamps no git block outside a checkout", async () => {
    const run = await exec(post(...BUG), { git: async () => undefined });
    expect(run.code).toBe(0);
    expect((await item("open")).from).toEqual({
      agentId: BOT,
      run: "req-1",
      cwd: dir,
    });
  });
});

describe("grokbot inbox-post with a JSON draft", () => {
  const draft = {
    project: "Demo App",
    kind: "bug",
    title: "Login fails",
    ask: { doneWhen: "Login works" },
    details: { summary: "It fails.", repro: ["open /login"] },
    work: {
      latest: {
        at: "repo",
        url: "https://github.com/example-org/example-app",
        commit: GIT.commit,
      },
      next: {
        at: "owner-computer",
        path: "/Users/someone/app",
        by: "session",
        needs: ["review"],
      },
    },
    dedupeKey: "login",
  };

  it("reads it from stdin and combines with --file and --expires-in", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    const run = await exec(
      post("--json", "-", "--file", "a.txt", "--expires-in", "2d"),
      {
        stdin: JSON.stringify(draft),
      },
    );
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(await item("open")).toMatchObject({
      work: draft.work,
      files: [{ name: "a.txt" }],
      expiresAt: "2026-10-22T10:00:00Z",
    });
  });

  it("reads it from a file", async () => {
    await writeFile(join(dir, "draft.json"), JSON.stringify(draft));
    expect((await exec(post("--json-file", "draft.json"))).code).toBe(0);
    expect(await open()).toHaveLength(1);
  });

  it("reports validation errors with exact paths", async () => {
    const run = await exec(post("--json", "-"), {
      stdin: JSON.stringify({
        ...draft,
        work: {
          next: {
            at: "bot",
            by: "bot",
            agentId: BOT,
            needs: ["review", "luck"],
          },
        },
        refs: [{ label: "x", url: "http://example.com" }],
        id: "abcd1234",
      }),
    });
    expect(run.code).toBe(2);
    expect(
      out(run)
        .errors.map((e: { path: string }) => e.path)
        .sort(),
    ).toEqual(["id", "refs[0].url", "work.next.needs[1]"]);
  });

  it.each([
    ["invalid JSON", "{nope", "--json"],
    ["a JSON array", "[]", "draft"],
  ])("refuses %s", async (_, stdin, path) => {
    const run = await exec(post("--json", "-"), { stdin });
    expect(run.code).toBe(2);
    expect(out(run).errors[0].path).toBe(path);
  });

  it("refuses to mix a draft with the flags that build one", async () => {
    const run = await exec(
      post("--json", "-", "--title", "x", "--kind", "bug"),
      {
        stdin: JSON.stringify(draft),
      },
    );
    expect(run.code).toBe(2);
    expect(
      out(run)
        .errors.map((e: { path: string }) => e.path)
        .sort(),
    ).toEqual(["--kind", "--title"]);
    expect(run.stdinReads).toBe(0);
  });

  it("takes only - for --json, and not both --json and --json-file", async () => {
    expect((await exec(post("--json", "{}"))).code).toBe(2);
    expect(
      (await exec(post("--json", "-", "--json-file", "x.json"))).code,
    ).toBe(2);
  });

  it("reports an unreadable input", async () => {
    const run = await exec(post("--json-file", "missing.json"));
    expect(run.code).toBe(2);
    expect(out(run).errors[0].path).toBe("--json-file");
  });
});

describe("grokbot inbox-update", () => {
  const posted = async () => out(await exec(post(...BUG))).id as string;

  it("adds a note, and sets severity and state", async () => {
    const id = await posted();
    now += 60_000;
    const run = await exec(
      [
        "inbox-update",
        id,
        "--note",
        "Reproduced.",
        "--severity",
        "high",
        "--state",
        "in-progress",
      ],
      { env: botEnv({ CURSOR_REQUEST_ID: "req-7" }) },
    );
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(out(run)).toMatchObject({
      ok: true,
      id,
      project: "Demo App",
      slug: "demo-app",
      openInProject: 1,
      expired: [],
    });
    expect(await item("open")).toMatchObject({
      severity: "high",
      work: { state: "in-progress" },
      updatedAt: "2026-10-20T10:01:00Z",
      updates: [
        { at: "2026-10-20T10:01:00Z", run: "req-7", note: "Reproduced." },
      ],
    });
  });

  it("works by hand, without the bot environment", async () => {
    const id = await posted();
    const run = await exec(["inbox-update", id, "--note", "Hi"], {
      env: { GROKBOT_INBOX_ROOT: root },
    });
    expect(run.code).toBe(0);
    expect((await item("open")).updates).toEqual([
      { at: "2026-10-20T10:00:00Z", note: "Hi" },
    ]);
  });

  it.each([
    ["no id", ["inbox-update", "--note", "x"], 2],
    ["no note", ["inbox-update", "abcd1234"], 2],
    [
      "an unknown state",
      ["inbox-update", "abcd1234", "--note", "x", "--state", "stuck"],
      2,
    ],
    [
      "an unknown flag",
      ["inbox-update", "abcd1234", "--note", "x", "--bogus", "1"],
      2,
    ],
  ])("refuses %s", async (_, argv, code) => {
    await posted();
    const run = await exec(argv);
    expect(run.code).toBe(code);
    expect(out(run).ok).toBe(false);
  });

  it("exits 1 for an unknown or closed item", async () => {
    const id = await posted();
    const unknown = await exec(["inbox-update", "zzzzzzzz", "--note", "x"]);
    expect(unknown.code).toBe(1);
    expect(out(unknown).errors[0].path).toBe("id");
    await exec(["inbox-close", id, "--outcome", "done"]);
    expect((await exec(["inbox-update", id, "--note", "x"])).code).toBe(1);
  });
});

describe("grokbot inbox-close", () => {
  const posted = async () => out(await exec(post(...BUG))).id as string;

  it("moves the item to closed/ stamped with the bot, the outcome, the reason and the ref", async () => {
    const id = await posted();
    now += 120_000;
    const run = await exec([
      "inbox-close",
      id,
      "--outcome",
      "fixed",
      "--reason",
      "Patched.",
      "--ref",
      "https://example.com/pr/1",
    ]);
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(out(run)).toMatchObject({
      ok: true,
      id,
      openInProject: 0,
      expired: [],
    });
    expect(await open()).toEqual([]);
    expect(out(run).path).toBe(
      join(root, "demo-app", "closed", "20261020T100000Z_bug_id000001.json"),
    );
    expect(await item("closed")).toMatchObject({
      status: "closed",
      closed: {
        at: "2026-10-20T10:02:00Z",
        by: BOT,
        outcome: "fixed",
        reason: "Patched.",
        ref: "https://example.com/pr/1",
      },
    });
  });

  it("closes as grokbot when a person runs it by hand", async () => {
    const id = await posted();
    const run = await exec(["inbox-close", id, "--outcome", "wont-fix"], {
      env: { GROKBOT_INBOX_ROOT: root },
    });
    expect(run.code).toBe(0);
    expect((await item("closed")).closed?.by).toBe("grokbot");
  });

  it("lists the allowed outcomes for an unknown one and changes nothing", async () => {
    const id = await posted();
    const run = await exec(["inbox-close", id, "--outcome", "shelved"]);
    expect(run.code).toBe(2);
    for (const outcome of INBOX_OUTCOMES)
      expect(out(run).errors[0].message).toContain(outcome);
    expect(await open()).toHaveLength(1);
  });

  it("needs an outcome", async () => {
    const id = await posted();
    expect((await exec(["inbox-close", id])).code).toBe(2);
  });

  it("says not found with exit 1, listing nothing, and refuses a second close", async () => {
    const id = await posted();
    const missing = await exec([
      "inbox-close",
      "zzzzzzzz",
      "--outcome",
      "done",
    ]);
    expect(missing.code).toBe(1);
    expect(out(missing).errors).toHaveLength(1);
    expect(missing.stdout).not.toContain(id);
    await exec(["inbox-close", id, "--outcome", "done"]);
    expect((await exec(["inbox-close", id, "--outcome", "fixed"])).code).toBe(
      1,
    );
  });
});

describe("pruning on every post, update and close", () => {
  it("closes expired items and reports them, then deletes old closed ones", async () => {
    const question = out(
      await exec(
        post(
          "--project",
          "Demo App",
          "--kind",
          "question",
          "--title",
          "Which?",
        ),
      ),
    ).id as string;
    now += 3 * DAY;
    const next = out(await exec(post(...BUG)));
    expect(next.expired).toEqual([
      { id: question, project: "Demo App", title: "Which?" },
    ]);
    expect(next.openInProject).toBe(1);
    expect(await readdir(join(root, "demo-app", "closed"))).toHaveLength(1);
    now += 31 * DAY;
    await exec(["inbox-update", next.id, "--note", "still here"]);
    // The question was closed 31 days ago and is gone; the bug has expired by now.
    const closed = await readdir(join(root, "demo-app", "closed"));
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain(next.id);
  });
});

describe("grokbot inbox-schema", () => {
  it("prints the item JSON Schema", async () => {
    const run = await exec(["inbox-schema"]);
    expect(run).toMatchObject({ code: 0, stderr: "", calls: [] });
    expect(JSON.parse(run.stdout)).toEqual(
      JSON.parse(JSON.stringify(INBOX_ITEM_JSON_SCHEMA)),
    );
    expect(out(run).$schema).toContain("2020-12");
  });

  it("works without the bot environment and takes no arguments", async () => {
    expect((await exec(["inbox-schema"], { env: {} })).code).toBe(0);
    expect((await exec(["inbox-schema", "x"])).code).toBe(2);
  });
});

describe("help and wiring", () => {
  it.each(INBOX_BOT_COMMANDS)(
    "%s --help prints its own usage and exits 0",
    async (name) => {
      for (const argv of [
        [name, "--help"],
        ["help", name],
        [name, "-h"],
      ]) {
        const run = await exec(argv);
        expect(run).toMatchObject({ code: 0, stderr: "" });
        expect(run.stdout).toContain(`grokbot ${name}`);
        expect(run.runnerOptions).toEqual([]);
      }
    },
  );

  it("lists the commands under a group for bots in general help", async () => {
    const run = await exec(["--help"]);
    const group =
      run.stdout.split("For bots (run on the cloud computer):\n")[1] ?? "";
    for (const name of INBOX_BOT_COMMANDS)
      expect(group).toMatch(new RegExp(`^ {2}${name}\\s+\\S`, "m"));
  });

  it("keeps them out of the catalog, so MCP never offers them", () => {
    const names = listCommands().map((c) => c.name);
    for (const name of INBOX_BOT_COMMANDS) expect(names).not.toContain(name);
  });

  it("never builds the runner or touches the sign-in", async () => {
    const calls = await Promise.all([
      exec(post(...BUG)),
      exec(["inbox-schema"]),
      exec(["inbox-close", "zzzzzzzz", "--outcome", "done"]),
    ]);
    for (const run of calls)
      expect(run).toMatchObject({ calls: [], runnerOptions: [] });
  });
});

describe("on a computer without the Keychain", () => {
  it("the command modules never import auth or Keychain code", async () => {
    for (const file of ["inbox-bot-commands.ts", "inbox-bot-flags.ts"]) {
      const source = await readFile(
        new URL(`./${file}`, import.meta.url),
        "utf8",
      );
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      expect(
        imports.filter((from) => /auth|keychain|credential/i.test(from ?? "")),
      ).toEqual([]);
      expect(source).not.toMatch(/\/usr\/bin\/security|spawn\(|execFile/);
    }
  });

  it("runs the commands without spawning anything but git", async () => {
    spawned.length = 0;
    const sink = () => ({ write: () => true });
    const ctx = {
      stdout: sink(),
      stderr: sink(),
      env: botEnv(),
      caller: { label: "script", signal: "no terminal on stdin" },
      isTTY: false,
    } as const;
    expect(await runLocal("inbox-schema", [], ctx)).toBe(0);
    expect(await runLocal("inbox-post", ["--bogus", "1"], ctx)).toBe(2);
    expect(
      await runLocal("inbox-close", ["zzzzzzzz", "--outcome", "done"], ctx),
    ).toBe(1);
    expect(await runLocal("inbox-post", [...BUG], ctx)).toBe(0);
    expect(spawned.length).toBeGreaterThan(0);
    expect(new Set(spawned)).toEqual(new Set(["git"]));
  });
});

describe("inbox storage layout", () => {
  it("keeps every file under <slug>/{open,closed,files}", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    const id = out(await exec(post(...BUG, "--file", "a.txt"))).id as string;
    await exec(["inbox-close", id, "--outcome", "done"]);
    const tree = async (path: string): Promise<string[]> => {
      const names = await readdir(path, { withFileTypes: true });
      const nested = await Promise.all(
        names.map(async (e) =>
          e.isDirectory()
            ? (await tree(join(path, e.name))).map((n) => `${e.name}/${n}`)
            : [e.name],
        ),
      );
      return nested.flat().sort();
    };
    expect(await tree(root)).toEqual([
      "demo-app/closed/20261020T100000Z_bug_id000001.json",
      "demo-app/files/id000001/a.txt",
    ]);
    await mkdir(join(root, "demo-app", "open"), { recursive: true });
  });
});
