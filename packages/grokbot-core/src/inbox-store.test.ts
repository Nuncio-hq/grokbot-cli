import { createHash } from "node:crypto";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schemaErrors } from "./fixtures/json-schema-lite.js";
import {
  INBOX_ITEM_JSON_SCHEMA,
  INBOX_LIMITS,
  INBOX_OUTCOMES,
  type InboxItem,
} from "./inbox-schema.js";
import {
  type InboxFailure,
  type InboxPostRequest,
  inboxRoot,
  inboxStore,
} from "./inbox-store.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const OTHER_BOT = "0a1b2c3d-2222-4222-8222-222222222222";
const DAY = 86_400_000;
const FROM = { agentId: BOT, run: "req-1", cwd: "/workspace/app" };

let dir: string;
let root: string;
let now: number;
let counter: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-inbox-"));
  root = join(dir, "inbox");
  now = Date.parse("2026-10-20T10:00:00Z");
  counter = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = () =>
  inboxStore({
    root,
    now: () => now,
    randomId: () => `id${String(++counter).padStart(6, "0")}`,
  });

const bug = (extra: object = {}) => ({
  project: "Demo App",
  kind: "bug",
  title: "Login fails",
  ask: { doneWhen: "Login works" },
  ...extra,
});
const request = (draft: unknown, extra: Partial<InboxPostRequest> = {}) => ({
  draft,
  from: FROM,
  ...extra,
});

const read = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as InboxItem;
const list = async (...parts: string[]) => {
  try {
    return (await readdir(join(root, ...parts))).sort();
  } catch {
    return [];
  }
};
const failure = (result: { readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  return result as InboxFailure;
};
const posted = async (
  draft: unknown,
  extra: Partial<InboxPostRequest> = {},
) => {
  const result = await store().post(request(draft, extra));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
};

describe("inboxRoot", () => {
  it("is /workspace/.grokbot/inbox unless GROKBOT_INBOX_ROOT says otherwise", () => {
    expect(inboxRoot({})).toBe("/workspace/.grokbot/inbox");
    expect(inboxRoot({ GROKBOT_INBOX_ROOT: " /tmp/x " })).toBe("/tmp/x");
    expect(inboxRoot({ GROKBOT_INBOX_ROOT: "  " })).toBe(
      "/workspace/.grokbot/inbox",
    );
  });
});

describe("post", () => {
  it("writes one stamped file into <slug>/open/ with its keys in file order", async () => {
    const result = await posted(
      bug({
        startHere: "bun test",
        details: { summary: "It fails." },
        work: { state: "in-progress" },
        refs: [{ label: "log", url: "https://example.com/log" }],
        replyTo: { agentId: OTHER_BOT },
        relatesTo: ["abcd1234"],
        dedupeKey: "login",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      id: "id000001",
      project: "Demo App",
      slug: "demo-app",
      deduped: false,
      openInProject: 1,
      expired: [],
    });
    expect(result.path).toBe(
      join(root, "demo-app", "open", "20261020T100000Z_bug_id000001.json"),
    );
    const text = await readFile(result.path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "schema"');
    const item = JSON.parse(text) as InboxItem;
    expect(Object.keys(item)).toEqual([
      "schema",
      "id",
      "project",
      "kind",
      "severity",
      "title",
      "startHere",
      "ask",
      "details",
      "work",
      "refs",
      "replyTo",
      "relatesTo",
      "dedupeKey",
      "from",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "status",
    ]);
    expect(item).toMatchObject({
      schema: "grokbot.inbox.item/v1",
      severity: "normal",
      from: FROM,
      createdAt: "2026-10-20T10:00:00Z",
      updatedAt: "2026-10-20T10:00:00Z",
      expiresAt: "2026-11-03T10:00:00Z",
      status: "open",
    });
    expect(Object.keys(item.from)).toEqual(["agentId", "run", "cwd"]);
  });

  it("drops empty values and leaves no temp files behind", async () => {
    const result = await posted(
      bug({
        startHere: "",
        details: { summary: " " },
        refs: [],
        ask: { doneWhen: "x", verify: "" },
      }),
    );
    const text = await readFile(result.path, "utf8");
    expect(text).not.toMatch(/null|\[\]|""/);
    expect(await list("demo-app", "open")).toEqual([
      "20261020T100000Z_bug_id000001.json",
    ]);
  });

  it("expires by kind: question 2 days, result 7, others 14, or --expires-in", async () => {
    const expiry = async (
      kind: string,
      extra: Partial<InboxPostRequest> = {},
    ) =>
      (
        await read(
          (
            await posted(
              { project: "P", kind, title: kind, ask: { doneWhen: "x" } },
              extra,
            )
          ).path,
        )
      ).expiresAt;
    expect(await expiry("question")).toBe("2026-10-22T10:00:00Z");
    expect(await expiry("result")).toBe("2026-10-27T10:00:00Z");
    expect(await expiry("task")).toBe("2026-11-03T10:00:00Z");
    expect(await expiry("decision")).toBe("2026-11-03T10:00:00Z");
    expect(await expiry("bug", { expiresInMs: 3_600_000 })).toBe(
      "2026-10-20T11:00:00Z",
    );
  });

  it("refuses an invalid draft and writes nothing", async () => {
    const result = failure(
      await store().post(request({ project: "P", kind: "story" })),
    );
    expect(result.kind).toBe("invalid");
    expect(result.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(["kind", "title"]),
    );
    expect(await list()).toEqual([]);
  });

  it("files an item with no letters in its project under _general", async () => {
    expect((await posted(bug({ project: "???" }))).slug).toBe("_general");
  });

  it("counts the open items of the project", async () => {
    await posted(bug());
    await posted(bug({ title: "Second" }));
    const other = await posted(bug({ project: "Other" }));
    expect(other.openInProject).toBe(1);
    expect((await posted(bug({ title: "Third" }))).openInProject).toBe(3);
  });

  it("gives every item its own id", async () => {
    const ids = new Set<string>();
    const real = inboxStore({ root, now: () => now });
    for (let i = 0; i < 5; i++) {
      const result = await real.post(request(bug({ title: `t${i}` })));
      if (result.ok) ids.add(result.id);
    }
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe("dedupe", () => {
  it("updates the open item with the same dedupeKey in the same project instead of adding one", async () => {
    const first = await posted(
      bug({
        severity: "high",
        dedupeKey: "login",
        ask: { doneWhen: "Login works" },
      }),
    );
    now += 3_600_000;
    const second = await posted(
      bug({
        title: "Login still fails",
        dedupeKey: "login",
        ask: { doneWhen: "Login works", verify: "bun test" },
        details: { summary: "Again." },
      }),
      { from: { ...FROM, run: "req-2" } },
    );
    expect(second).toMatchObject({
      deduped: true,
      id: first.id,
      openInProject: 1,
    });
    expect(second.path).toBe(first.path);
    expect(await list("demo-app", "open")).toHaveLength(1);
    const item = await read(second.path);
    expect(item).toMatchObject({
      id: first.id,
      title: "Login still fails",
      severity: "high",
      ask: { doneWhen: "Login works", verify: "bun test" },
      details: { summary: "Again." },
      createdAt: "2026-10-20T10:00:00Z",
      updatedAt: "2026-10-20T11:00:00Z",
      updates: [
        { at: "2026-10-20T11:00:00Z", run: "req-2", note: "re-posted" },
      ],
    });
    expect(item.expiresAt).toBe("2026-11-03T11:00:00Z");
    expect(Object.keys(item).indexOf("updates")).toBeGreaterThan(
      Object.keys(item).indexOf("expiresAt"),
    );
  });

  it("takes a given severity over the old one", async () => {
    const first = await posted(bug({ dedupeKey: "k", severity: "high" }));
    await posted(bug({ dedupeKey: "k", severity: "low" }));
    expect((await read(first.path)).severity).toBe("low");
  });

  it("keeps only the newest 20 updates", async () => {
    const first = await posted(bug({ dedupeKey: "k" }));
    for (let i = 0; i < 25; i++) {
      now += 1000;
      await posted(bug({ dedupeKey: "k" }));
    }
    expect((await read(first.path)).updates).toHaveLength(INBOX_LIMITS.updates);
  });

  it("keeps projects, closed items and keyless posts apart", async () => {
    const a = await posted(bug({ dedupeKey: "k" }));
    const otherProject = await posted(
      bug({ project: "Other", dedupeKey: "k" }),
    );
    expect(otherProject.id).not.toBe(a.id);
    await posted(bug());
    await posted(bug());
    expect(await list("demo-app", "open")).toHaveLength(3);
    await store().close({ id: a.id, outcome: "fixed", by: BOT });
    const again = await posted(bug({ dedupeKey: "k" }));
    expect(again).toMatchObject({ deduped: false });
    expect(again.id).not.toBe(a.id);
  });

  it("refuses a repost of another kind", async () => {
    await posted(bug({ dedupeKey: "k" }));
    const result = failure(
      await store().post(
        request({
          project: "Demo App",
          kind: "result",
          title: "t",
          dedupeKey: "k",
        }),
      ),
    );
    expect(result.kind).toBe("invalid");
    expect(result.errors[0]?.path).toBe("kind");
  });
});

describe("files", () => {
  const make = async (name: string, content: string | Buffer, sub = "src") => {
    const folder = join(dir, sub);
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await writeFile(path, content);
    return path;
  };

  it("copies each file into files/<id>/ with its size, type and sha256", async () => {
    const log = await make("run.log", "line one\nline two\n");
    const png = await make(
      "shot.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    );
    const result = await posted(bug(), { files: [log, png] });
    const item = await read(result.path);
    expect(item.files).toEqual([
      {
        name: "run.log",
        path: `files/${result.id}/run.log`,
        sizeBytes: 18,
        contentType: "text/plain",
        sha256: createHash("sha256")
          .update("line one\nline two\n")
          .digest("hex"),
      },
      {
        name: "shot.png",
        path: `files/${result.id}/shot.png`,
        sizeBytes: 7,
        contentType: "image/png",
        sha256: createHash("sha256")
          .update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
          .digest("hex"),
      },
    ]);
    expect(
      await readFile(
        join(root, "demo-app", "files", result.id, "run.log"),
        "utf8",
      ),
    ).toBe("line one\nline two\n");
    const keys = Object.keys(item);
    expect(keys.indexOf("files")).toBe(keys.indexOf("from") - 1);
  });

  it("renames files that share a name", async () => {
    const a = await make("out.txt", "a", "one");
    const b = await make("out.txt", "b", "two");
    const result = await posted(bug(), { files: [a, b] });
    expect((await read(result.path)).files?.map((f) => f.name)).toEqual([
      "out.txt",
      "out-2.txt",
    ]);
  });

  it("refuses a missing file, naming it", async () => {
    const result = failure(
      await store().post(request(bug(), { files: [join(dir, "nope.txt")] })),
    );
    expect(result.errors[0]?.path).toBe("files[0]");
    expect(await list()).toEqual([]);
  });

  it("refuses more than 10 files", async () => {
    const files = await Promise.all(
      Array.from({ length: 11 }, (_, i) => make(`f${i}.txt`, String(i))),
    );
    const result = failure(await store().post(request(bug(), { files })));
    expect(result.errors[0]?.path).toBe("files");
  });

  it("refuses files over 10 MB together, before writing anything", async () => {
    const big = await make(
      "big.bin",
      Buffer.alloc(INBOX_LIMITS.fileBytes + 1, 1),
    );
    const result = failure(
      await store().post(request(bug(), { files: [big] })),
    );
    expect(result.errors[0]?.path).toBe("files[0]");
    expect(await list()).toEqual([]);
  });

  it("refuses a file that holds a credential", async () => {
    const leaky = await make(
      "env.txt",
      `TOKEN=${"ghp"}_${"a1b2c3d4e5".repeat(4)}\n`,
    );
    const result = failure(
      await store().post(request(bug(), { files: [leaky] })),
    );
    expect(result.errors[0]?.path).toBe("files[0]");
    expect(await list()).toEqual([]);
  });

  it("merges files by name when a dedupe repost adds some", async () => {
    const one = await make("a.txt", "one");
    const first = await posted(bug({ dedupeKey: "k" }), { files: [one] });
    const two = await make("b.txt", "two", "other");
    const newer = await make("a.txt", "one, newer", "newer");
    await posted(bug({ dedupeKey: "k" }), { files: [two, newer] });
    const files = (await read(first.path)).files ?? [];
    expect(files.map((f) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
    expect(files.find((f) => f.name === "a.txt")?.sha256).toBe(
      createHash("sha256").update("one, newer").digest("hex"),
    );
    expect(
      await readFile(
        join(root, "demo-app", "files", first.id, "a.txt"),
        "utf8",
      ),
    ).toBe("one, newer");
  });

  it("enforces the limits on the merged set", async () => {
    const first = await make("a.bin", Buffer.alloc(6 * 1024 * 1024, 1));
    await posted(bug({ dedupeKey: "k" }), { files: [first] });
    const second = await make("b.bin", Buffer.alloc(6 * 1024 * 1024, 2));
    const result = failure(
      await store().post(request(bug({ dedupeKey: "k" }), { files: [second] })),
    );
    expect(result.errors[0]?.path).toBe("files");
  });
});

describe("update", () => {
  it("appends a note, bumps updatedAt and sets severity and state", async () => {
    const item = await posted(
      bug({ work: { next: { at: "bot", agentId: OTHER_BOT, by: "bot" } } }),
    );
    now += 60_000;
    const result = await store().update({
      id: item.id,
      note: "Reproduced it.",
      run: "req-9",
      severity: "high",
      state: "in-progress",
    });
    expect(result).toMatchObject({
      ok: true,
      id: item.id,
      openInProject: 1,
      expired: [],
    });
    const after = await read(item.path);
    expect(after).toMatchObject({
      severity: "high",
      updatedAt: "2026-10-20T10:01:00Z",
      createdAt: "2026-10-20T10:00:00Z",
      updates: [
        { at: "2026-10-20T10:01:00Z", run: "req-9", note: "Reproduced it." },
      ],
    });
    expect(Object.keys(after.work ?? {})).toEqual(["state", "next"]);
    expect(after.work?.state).toBe("in-progress");
  });

  it("omits the run when a person ran it", async () => {
    const item = await posted(bug());
    await store().update({ id: item.id, note: "By hand." });
    expect((await read(item.path)).updates?.[0]).toEqual({
      at: "2026-10-20T10:00:00Z",
      note: "By hand.",
    });
  });

  it.each([
    ["no note", { note: "" }, "note"],
    ["an unknown severity", { note: "x", severity: "urgent" }, "severity"],
    ["an unknown state", { note: "x", state: "stuck" }, "state"],
    ["a credential", { note: `${"ghp"}_${"a1b2c3d4e5".repeat(4)}` }, "note"],
    ["a note over 300 characters", { note: "x".repeat(301) }, "note"],
  ])("refuses %s", async (_, change, path) => {
    const item = await posted(bug());
    const result = failure(await store().update({ id: item.id, ...change }));
    expect(result.kind).toBe("invalid");
    expect(result.errors.map((e) => e.path)).toContain(path);
    expect((await read(item.path)).updates).toBeUndefined();
  });

  it("says not found for an unknown id and refuses a closed item", async () => {
    expect(
      failure(await store().update({ id: "zzzzzzzz", note: "x" })).kind,
    ).toBe("not-found");
    const item = await posted(bug());
    await store().close({ id: item.id, outcome: "done", by: BOT });
    expect(failure(await store().update({ id: item.id, note: "x" })).kind).toBe(
      "closed",
    );
  });
});

describe("close", () => {
  it("moves the file to closed/ with who, why and what came of it", async () => {
    const item = await posted(bug());
    now += 120_000;
    const result = await store().close({
      id: item.id,
      outcome: "fixed",
      by: BOT,
      reason: "Patched the redirect.",
      ref: "https://example.com/pr/1",
    });
    expect(result).toMatchObject({ ok: true, id: item.id, openInProject: 0 });
    expect(await list("demo-app", "open")).toEqual([]);
    expect(await list("demo-app", "closed")).toEqual([
      "20261020T100000Z_bug_id000001.json",
    ]);
    const closed = await read(
      join(root, "demo-app", "closed", "20261020T100000Z_bug_id000001.json"),
    );
    expect(closed).toMatchObject({
      status: "closed",
      updatedAt: "2026-10-20T10:02:00Z",
      closed: {
        at: "2026-10-20T10:02:00Z",
        by: BOT,
        outcome: "fixed",
        reason: "Patched the redirect.",
        ref: "https://example.com/pr/1",
      },
    });
    expect(Object.keys(closed.closed ?? {})).toEqual([
      "at",
      "by",
      "outcome",
      "reason",
      "ref",
    ]);
    expect(Object.keys(closed).slice(-2)).toEqual(["status", "closed"]);
  });

  it("keeps the item's files", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "a");
    const item = await posted(bug(), { files: [path] });
    await store().close({ id: item.id, outcome: "done", by: "grokbot" });
    expect(await list("demo-app", "files", item.id)).toEqual(["a.txt"]);
  });

  it("accepts every outcome", async () => {
    for (const outcome of INBOX_OUTCOMES) {
      const item = await posted(bug({ title: outcome }));
      expect(
        await store().close({ id: item.id, outcome, by: BOT }),
      ).toMatchObject({ ok: true });
    }
  });

  it("lists the allowed outcomes when given an unknown one, and changes nothing", async () => {
    const item = await posted(bug());
    const result = failure(
      await store().close({ id: item.id, outcome: "shelved", by: BOT }),
    );
    expect(result.kind).toBe("invalid");
    for (const outcome of INBOX_OUTCOMES)
      expect(result.errors[0]?.message).toContain(outcome);
    expect(await list("demo-app", "open")).toHaveLength(1);
  });

  it("refuses a non-https ref, a long reason and a credential", async () => {
    const item = await posted(bug());
    for (const change of [
      { ref: "http://example.com" },
      { reason: "x".repeat(301) },
      { reason: `${"ghp"}_${"a1b2c3d4e5".repeat(4)}` },
    ])
      expect(
        failure(
          await store().close({
            id: item.id,
            outcome: "done",
            by: BOT,
            ...change,
          }),
        ).kind,
      ).toBe("invalid");
  });

  it("says not found for an unknown id without listing anything, and refuses a second close", async () => {
    const item = await posted(bug());
    const missing = failure(
      await store().close({ id: "zzzzzzzz", outcome: "done", by: BOT }),
    );
    expect(missing.kind).toBe("not-found");
    expect(JSON.stringify(missing)).not.toContain(item.id);
    await store().close({ id: item.id, outcome: "done", by: BOT });
    expect(
      failure(await store().close({ id: item.id, outcome: "fixed", by: BOT }))
        .kind,
    ).toBe("closed");
  });
});

describe("prune", () => {
  it("closes open items past expiresAt as expired by grokbot, and reports them", async () => {
    const question = await posted({
      project: "Demo App",
      kind: "question",
      title: "Which?",
    });
    const keeper = await posted(bug());
    now += 3 * DAY;
    const next = await posted(bug({ title: "Fresh" }));
    expect(next.expired).toEqual([
      { id: question.id, project: "Demo App", title: "Which?" },
    ]);
    expect(next.openInProject).toBe(2);
    expect(await list("demo-app", "open")).toHaveLength(2);
    const closed = await read(
      join(
        root,
        "demo-app",
        "closed",
        `20261020T100000Z_question_${question.id}.json`,
      ),
    );
    expect(closed).toMatchObject({
      status: "closed",
      closed: { by: "grokbot", outcome: "expired", at: "2026-10-23T10:00:00Z" },
    });
    expect((await read(keeper.path)).status).toBe("open");
  });

  it("also runs on update and close", async () => {
    const question = await posted({
      project: "Demo App",
      kind: "question",
      title: "Which?",
    });
    const a = await posted(bug({ title: "a" }));
    const b = await posted(bug({ title: "b" }));
    now += 3 * DAY;
    const updated = await store().update({ id: a.id, note: "x" });
    expect(updated.ok && updated.expired.map((e) => e.id)).toEqual([
      question.id,
    ]);
    now += 20 * DAY;
    const closed = await store().close({ id: b.id, outcome: "done", by: BOT });
    expect(closed.ok && closed.expired.map((e) => e.id).sort()).toEqual([a.id]);
  });

  it("lets an item that expired but was not swept yet still be closed with a real outcome", async () => {
    const question = await posted({
      project: "Demo App",
      kind: "question",
      title: "Which?",
    });
    now += 3 * DAY;
    const result = await store().close({
      id: question.id,
      outcome: "answered",
      by: BOT,
    });
    expect(result).toMatchObject({ ok: true, expired: [] });
    const closed = await read(result.ok ? result.path : "");
    expect(closed.closed?.outcome).toBe("answered");
  });

  it("deletes closed items, and their files, 30 days after they were closed", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "a");
    const item = await posted(bug(), { files: [path] });
    await store().close({ id: item.id, outcome: "done", by: BOT });
    const closedFile = join(
      root,
      "demo-app",
      "closed",
      "20261020T100000Z_bug_id000001.json",
    );

    now += 30 * DAY;
    await store().prune();
    expect(await list("demo-app", "closed")).toHaveLength(1);

    now += 1000;
    await store().prune();
    expect(await list("demo-app", "closed")).toEqual([]);
    await expect(
      stat(join(root, "demo-app", "files", item.id)),
    ).rejects.toThrow();
    await expect(stat(closedFile)).rejects.toThrow();
  });

  it("counts the 30 days from when it was closed, not from when it was posted", async () => {
    const item = await posted(bug());
    now += 25 * DAY;
    await store().close({ id: item.id, outcome: "done", by: BOT });
    now += 25 * DAY;
    await store().prune();
    expect(await list("demo-app", "closed")).toHaveLength(1);
  });

  it("leaves files it cannot read alone", async () => {
    await posted(bug());
    await mkdir(join(root, "demo-app", "closed"), { recursive: true });
    const stray = join(
      root,
      "demo-app",
      "closed",
      "20200101T000000Z_bug_zzzzzzzz.json",
    );
    await writeFile(stray, "{not json");
    now += 90 * DAY;
    await store().prune();
    expect(await readFile(stray, "utf8")).toBe("{not json");
  });

  it("finishes a close that stopped half way", async () => {
    const item = await posted(bug());
    await store().close({ id: item.id, outcome: "done", by: BOT });
    const open = join(
      root,
      "demo-app",
      "open",
      "20261020T100000Z_bug_id000001.json",
    );
    await mkdir(join(root, "demo-app", "open"), { recursive: true });
    await writeFile(
      open,
      await readFile(
        join(root, "demo-app", "closed", "20261020T100000Z_bug_id000001.json"),
        "utf8",
      ),
    );
    await store().prune();
    expect(await list("demo-app", "open")).toEqual([]);
  });
});

describe("the item schema", () => {
  const FULL = bug({
    severity: "high",
    startHere: "bun test",
    ask: {
      doneWhen: "Login works",
      verify: "bun test",
      reply: "A line",
      blocking: "release",
    },
    details: {
      summary: "It fails.",
      observed: "500",
      expected: "200",
      repro: ["open /login"],
      alreadyChecked: ["cache"],
      firstSeenAt: "2026-10-19T08:00:00Z",
      occurrences: 3,
    },
    work: {
      state: "blocked",
      trail: [
        {
          at: "owner-computer",
          machine: { id: "m1", label: "example-mac" },
          path: "/Users/someone/app",
          did: "ran the tests",
          asOf: "2026-10-20T09:00:00Z",
        },
        {
          at: "cloud-agent",
          cloudAgentId: "bc-1234",
          url: "https://example.com/agent",
          did: "asked",
        },
      ],
      latest: {
        at: "repo",
        url: "https://github.com/example/app",
        branch: "main",
        commit: "710511c",
      },
      next: {
        at: "bot",
        agentId: OTHER_BOT,
        by: "owner",
        action: "Approve the deploy",
        command: "grokbot inbox",
        needs: ["owner-approval", "review"],
      },
    },
    refs: [{ label: "log", url: "https://example.com/log" }],
    replyTo: { agentId: OTHER_BOT },
    to: {
      session: "omp:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      job: "1f2e3d4c",
    },
    relatesTo: ["abcd1234"],
    dedupeKey: "login",
  });

  it("validates a posted item, a file-carrying item, an updated one and a closed one", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "a");
    const item = await posted(FULL, { files: [path] });
    expect(schemaErrors(INBOX_ITEM_JSON_SCHEMA, await read(item.path))).toEqual(
      [],
    );
    await store().update({ id: item.id, note: "x", run: "r" });
    expect(schemaErrors(INBOX_ITEM_JSON_SCHEMA, await read(item.path))).toEqual(
      [],
    );
    const closed = await store().close({
      id: item.id,
      outcome: "fixed",
      by: BOT,
      reason: "done",
      ref: "https://example.com/pr/1",
    });
    expect(
      schemaErrors(
        INBOX_ITEM_JSON_SCHEMA,
        await read(closed.ok ? closed.path : ""),
      ),
    ).toEqual([]);
  });

  it("validates every kind a poster can write", async () => {
    for (const draft of [
      { project: "P", kind: "task", title: "t", ask: { doneWhen: "x" } },
      {
        project: "P",
        kind: "question",
        title: "t",
        ask: { choices: ["a", "b"] },
      },
      { project: "P", kind: "result", title: "t" },
      { project: "P", kind: "decision", title: "t", ask: { reply: "x" } },
    ]) {
      const item = await posted(draft);
      expect(
        schemaErrors(INBOX_ITEM_JSON_SCHEMA, await read(item.path)),
      ).toEqual([]);
    }
  });

  it("validates an item addressed to a job alone", async () => {
    const item = await posted(bug({ to: { job: "1F2E3D4C" } }));
    const stored = await read(item.path);
    expect(stored.to).toEqual({ job: "1f2e3d4c" });
    expect(schemaErrors(INBOX_ITEM_JSON_SCHEMA, stored)).toEqual([]);
  });

  it("rejects what the validator rejects", async () => {
    const item = await read((await posted(bug())).path);
    const mutate = (change: object) => ({ ...item, ...change });
    for (const broken of [
      mutate({ ask: undefined }),
      mutate({
        kind: "question",
        ask: { choices: ["a", "b"], doneWhen: "x" },
        details: { occurrences: 2 },
      }),
      mutate({ kind: "story" }),
      mutate({ status: "closed" }),
      mutate({
        closed: { at: "2026-10-20T10:00:00Z", by: "x", outcome: "done" },
      }),
      mutate({ extra: 1 }),
      mutate({ expiresAt: "tomorrow" }),
      mutate({ id: "short" }),
      mutate({
        work: { latest: { at: "web", url: "https://example.com", path: "/x" } },
      }),
      mutate({ work: { next: { at: "bot", agentId: BOT } } }),
      mutate({ to: { session: "not an address" } }),
      mutate({ to: { session: "omp:abcd1234", extra: 1 } }),
      mutate({ to: {} }),
      mutate({ to: { job: "short" } }),
      mutate({ to: { job: "not-a-hex-job" } }),
      mutate({ to: { job: "1f2e3d4c", bot: "x" } }),
    ])
      expect(
        schemaErrors(INBOX_ITEM_JSON_SCHEMA, JSON.parse(JSON.stringify(broken)))
          .length,
      ).toBeGreaterThan(0);
  });

  it("is a JSON Schema 2020-12 document whose required properties all exist", () => {
    expect(INBOX_ITEM_JSON_SCHEMA.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(() =>
      JSON.parse(JSON.stringify(INBOX_ITEM_JSON_SCHEMA)),
    ).not.toThrow();
    const missing: string[] = [];
    const visit = (node: unknown, path: string) => {
      if (typeof node !== "object" || node === null) return;
      if (Array.isArray(node)) {
        node.forEach((child, i) => {
          visit(child, `${path}[${i}]`);
        });
        return;
      }
      const schema = node as {
        required?: string[];
        properties?: Record<string, unknown>;
        type?: string;
      };
      if (schema.type === "object" && schema.required)
        for (const key of schema.required)
          if (!(key in (schema.properties ?? {})))
            missing.push(`${path}.${key}`);
      for (const [key, child] of Object.entries(node))
        visit(child, `${path}.${key}`);
    };
    visit(INBOX_ITEM_JSON_SCHEMA, "$");
    expect(missing).toEqual([]);
  });

  it("marks the stamped properties readOnly and no others", () => {
    const properties = INBOX_ITEM_JSON_SCHEMA.properties as Record<
      string,
      { readOnly?: boolean }
    >;
    const readOnly = Object.entries(properties)
      .filter(([, schema]) => schema.readOnly)
      .map(([key]) => key)
      .sort();
    expect(readOnly).toEqual(
      [
        "closed",
        "createdAt",
        "expiresAt",
        "files",
        "from",
        "id",
        "schema",
        "status",
        "updatedAt",
        "updates",
      ].sort(),
    );
  });
});
