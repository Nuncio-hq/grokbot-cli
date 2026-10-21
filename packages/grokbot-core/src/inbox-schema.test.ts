import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatInboxMessage,
  INBOX_KINDS,
  INBOX_NEEDS,
  INBOX_OUTCOMES,
  inboxFileName,
  inboxSlug,
  isInboxExpired,
  parseInboxExpiresIn,
  parseInboxFileName,
  validateInboxDraft,
} from "./inbox-schema.js";

const BOT = "0a1b2c3d-1111-4111-8111-111111111111";
const SHA = "710511cf814b99dea915f6ddfd3f955e84db469e";

const errorsOf = (draft: unknown) => {
  const result = validateInboxDraft(draft);
  return result.ok ? [] : result.errors;
};
const pathsOf = (draft: unknown) => errorsOf(draft).map((e) => e.path);
const bug = (extra: object = {}) => ({
  project: "App",
  kind: "bug",
  title: "Login fails",
  ask: { doneWhen: "Login works" },
  ...extra,
});

describe("validateInboxDraft", () => {
  it("returns the draft trimmed, defaulted and in file order, with empty values dropped", () => {
    const result = validateInboxDraft({
      dedupeKey: "k1",
      title: "  Login fails ",
      kind: "bug",
      project: " Demo App ",
      startHere: "",
      ask: { doneWhen: "Login works", verify: "  ", choices: [] },
      details: { summary: null },
      refs: [],
      relatesTo: ["abcd1234", "abcd1234"],
      work: {
        next: {
          by: "owner",
          at: "owner-computer",
          path: "/Users/someone/app",
          needs: ["review", "review"],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.item)).toEqual([
      "project",
      "kind",
      "severity",
      "title",
      "ask",
      "work",
      "relatesTo",
      "dedupeKey",
    ]);
    expect(result.item).toMatchObject({
      project: "Demo App",
      title: "Login fails",
      severity: "normal",
      ask: { doneWhen: "Login works" },
      relatesTo: ["abcd1234"],
    });
    expect(result.item.work?.next?.needs).toEqual(["review"]);
    expect(Object.keys(result.item.work?.next ?? {})).toEqual([
      "at",
      "path",
      "by",
      "needs",
    ]);
    expect(JSON.stringify(result.item)).not.toContain("null");
  });

  it.each([
    ["a missing project", bug({ project: undefined }), "project"],
    ["a missing title", bug({ title: "" }), "title"],
    ["a multi-line title", bug({ title: "a\nb" }), "title"],
    ["a title over 100 characters", bug({ title: "x".repeat(101) }), "title"],
    ["a bug without doneWhen", bug({ ask: {} }), "ask.doneWhen"],
    [
      "choices on a bug",
      bug({ ask: { doneWhen: "x", choices: ["a", "b"] } }),
      "ask.choices",
    ],
    [
      "one choice on a question",
      {
        project: "App",
        kind: "question",
        title: "Which?",
        ask: { choices: ["a"] },
      },
      "ask.choices",
    ],
    [
      "a multi-line choice",
      {
        project: "App",
        kind: "question",
        title: "Which?",
        ask: { choices: ["yes", "no\nmaybe"] },
      },
      "ask.choices[1]",
    ],
    [
      "a blank choice",
      {
        project: "App",
        kind: "question",
        title: "Which?",
        ask: { choices: ["yes", "", "no"] },
      },
      "ask.choices[1]",
    ],
    [
      "a null choice",
      {
        project: "App",
        kind: "question",
        title: "Which?",
        ask: { choices: ["yes", null, "no"] },
      },
      "ask.choices[1]",
    ],
    [
      "a multi-line next command",
      bug({
        work: {
          next: { at: "bot", agentId: BOT, by: "bot", command: "a\nb" },
        },
      }),
      "work.next.command",
    ],
    [
      "a blank repro step",
      bug({ details: { repro: ["open the page", "  ", "log in"] } }),
      "details.repro[1]",
    ],
    [
      "a null alreadyChecked entry",
      bug({ details: { alreadyChecked: [null] } }),
      "details.alreadyChecked[0]",
    ],
    [
      "occurrences on a result",
      {
        project: "App",
        kind: "result",
        title: "Done",
        details: { occurrences: 2 },
      },
      "details.occurrences",
    ],
    ["an unknown field", bug({ titel: "x" }), "titel"],
    ["a stamped field", bug({ id: "abcd1234" }), "id"],
    ["an attached file in the draft", bug({ files: [] }), "files"],
    [
      "an unknown need",
      bug({
        work: {
          next: {
            at: "bot",
            agentId: BOT,
            by: "bot",
            needs: ["review", "luck"],
          },
        },
      }),
      "work.next.needs[1]",
    ],
    [
      "a next step without who acts",
      bug({ work: { next: { at: "bot", agentId: BOT } } }),
      "work.next.by",
    ],
    [
      "a field the place does not take",
      bug({
        work: { latest: { at: "web", url: "https://example.com", path: "/x" } },
      }),
      "work.latest.path",
    ],
    [
      "a cloud path outside /workspace and /home",
      bug({ work: { latest: { at: "cloud-computer", path: "/etc/passwd" } } }),
      "work.latest.path",
    ],
    [
      "a relative owner path",
      bug({ work: { latest: { at: "owner-computer", path: "app/src" } } }),
      "work.latest.path",
    ],
    [
      "a non-https reference",
      bug({ refs: [{ label: "x", url: "http://example.com" }] }),
      "refs[0].url",
    ],
    [
      "a reference without label",
      bug({ refs: [{ url: "https://example.com" }] }),
      "refs[0].label",
    ],
    [
      "a malformed replyTo",
      bug({ replyTo: { agentId: "not-an-id" } }),
      "replyTo.agentId",
    ],
    ["a bad dedupeKey", bug({ dedupeKey: "Has Spaces" }), "dedupeKey"],
    [
      "six trail steps",
      bug({
        work: {
          trail: Array.from({ length: 6 }, () => ({
            at: "web",
            url: "https://example.com",
            did: "looked",
          })),
        },
      }),
      "work.trail",
    ],
    [
      "a trail step without did",
      bug({ work: { trail: [{ at: "web", url: "https://example.com" }] } }),
      "work.trail[0].did",
    ],
    ["a wrong severity", bug({ severity: "urgent" }), "severity"],
  ])("refuses %s at %s", (_, draft, path) => {
    expect(pathsOf(draft)).toContain(path);
  });

  it("keeps a session address in `to`, right after replyTo", () => {
    const result = validateInboxDraft(
      bug({
        relatesTo: ["abcd1234"],
        to: { session: " omp:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b " },
        replyTo: { agentId: BOT },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.to).toEqual({
      session: "omp:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    });
    expect(Object.keys(result.item).slice(-3)).toEqual([
      "replyTo",
      "to",
      "relatesTo",
    ]);
  });

  it.each([
    ["an id alone", "0190a1b2-c3d4"],
    ["a runtime in capitals", "OMP:abcd1234"],
    ["an id that is too short", "omp:abc"],
    ["an id with a space", "omp:abcd 1234"],
    ["an id that is too long", `omp:${"a".repeat(101)}`],
    ["two colons", "omp:abcd:1234"],
    ["a runtime alone", "omp:"],
  ])("refuses %s as a session address", (_, session) => {
    expect(pathsOf(bug({ to: { session } }))).toEqual(["to.session"]);
  });

  it.each([
    ["a null session", { to: { session: null } }, ["to.session"]],
    ["a session that is not text", { to: { session: 42 } }, ["to.session"]],
    [
      "another field",
      { to: { session: "omp:abcd1234", bot: "x" } },
      ["to.bot"],
    ],
    ["a `to` that is not an object", { to: "omp:abcd1234" }, ["to"]],
    ["an empty `to`", { to: {} }, ["to"]],
    ["a null job", { to: { job: null } }, ["to.job"]],
    ["a job that is not text", { to: { job: 42 } }, ["to.job"]],
    [
      "a job and another field",
      { to: { job: "1f2e3d4c", bot: "x" } },
      ["to.bot"],
    ],
  ])("refuses `to` with %s", (_, extra, paths) => {
    expect(pathsOf(bug(extra))).toEqual(paths);
  });

  it("says that `to` needs a session or a job", () => {
    const [error] = errorsOf(bug({ to: {} }));
    expect(error?.message).toContain("session");
    expect(error?.message).toContain("job");
  });

  it("keeps a job in `to`, lower-cased, alone or with its session", () => {
    const alone = validateInboxDraft(bug({ to: { job: " 1F2E3D4C " } }));
    expect(alone.ok && alone.item.to).toEqual({ job: "1f2e3d4c" });
    const both = validateInboxDraft(
      bug({
        to: {
          job: "1F2E3D4C-0000-4000-8000-000000000000",
          session: "omp:abcd1234",
        },
      }),
    );
    expect(both.ok && both.item.to).toEqual({
      session: "omp:abcd1234",
      job: "1f2e3d4c-0000-4000-8000-000000000000",
    });
  });

  it.each([
    ["too short", "1f2e3d4"],
    ["not hex", "1f2e3d4g"],
    ["with a space", "1f2e 3d4c"],
    ["with a colon", "omp:1f2e3d4c"],
  ])("refuses a job that is %s", (_, job) => {
    const [error] = errorsOf(bug({ to: { job } }));
    expect(error?.path).toBe("to.job");
    expect(error?.message).toContain("Job from a message header");
  });

  it("refuses a job of more than 36 characters", () => {
    expect(pathsOf(bug({ to: { job: "a".repeat(37) } }))).toEqual(["to.job"]);
  });

  it("lists the allowed values of an unknown kind, need and outcome-like enum", () => {
    const kind = errorsOf(bug({ kind: "story" })).find(
      (e) => e.path === "kind",
    );
    for (const allowed of INBOX_KINDS) expect(kind?.message).toContain(allowed);
    const need = errorsOf(
      bug({
        work: { next: { at: "bot", agentId: BOT, by: "bot", needs: ["luck"] } },
      }),
    ).find((e) => e.path === "work.next.needs[0]");
    for (const allowed of INBOX_NEEDS) expect(need?.message).toContain(allowed);
  });

  it("reports every problem at once", () => {
    expect(pathsOf({ kind: "story", title: "" })).toEqual(
      expect.arrayContaining(["project", "kind", "title"]),
    );
  });

  it("is not fooled by a non-object", () => {
    expect(errorsOf("text")).toHaveLength(1);
    expect(errorsOf(null)).toHaveLength(1);
    expect(errorsOf([])).toHaveLength(1);
  });

  describe("secrets", () => {
    const secrets: Record<string, string> = {
      "a private key": `-----BEGIN ${"PRIVATE"} KEY-----`,
      "a JWT": `${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890`,
      "an sk- key": `sk-${"proj"}1234567890abcdefghij`,
      "a live key": `${"sk"}_live_${"abcdefghij1234567890"}`,
      "a restricted live key": `${"rk"}_live_${"abcdefghij1234567890"}`,
      "a GitHub token": `${"ghp"}_${"a1b2c3d4e5".repeat(4)}`,
      "an OAuth GitHub token": `${"gho"}_${"a1b2c3d4e5".repeat(4)}`,
      "a server GitHub token": `${"ghs"}_${"a1b2c3d4e5".repeat(4)}`,
      "a fine-grained token": `github_pat_${"A1b2C3d4E5".repeat(3)}`,
      "a Slack token": `${"xoxb"}-1234567890-abcdefghij`,
      "an AWS key id": `${"AKIA"}ABCDEFGHIJKLMNOP`,
      "a Google key": `${"AIza"}${"SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"}`,
      "a bearer token": `Authorization: Bearer ${"abcdef0123456789".repeat(2)}`,
    };
    it.each(Object.entries(secrets))(
      "refuses %s, naming the field",
      (_, value) => {
        expect(
          pathsOf(bug({ details: { summary: `see ${value} here` } })),
        ).toContain("details.summary");
        expect(pathsOf(bug({ startHere: value }))).toContain("startHere");
        expect(
          pathsOf(
            bug({
              work: {
                next: { at: "bot", agentId: BOT, by: "bot", command: value },
              },
            }),
          ),
        ).toContain("work.next.command");
      },
    );

    it("never echoes the secret back", () => {
      const secret = `${"ghp"}_${"a1b2c3d4e5".repeat(4)}`;
      const messages = errorsOf(bug({ startHere: secret })).map(
        (e) => e.message,
      );
      for (const message of messages) expect(message).not.toContain(secret);
    });

    it("lets commit SHAs, ids and ordinary text through", () => {
      const result = validateInboxDraft(
        bug({
          title: "Task-force bearer of risk-free news",
          startHere: `git show ${SHA}`,
          details: { summary: `Fixed in ${SHA} (see 0a1b2c3d)` },
          relatesTo: ["abcd1234"],
          work: {
            latest: {
              at: "repo",
              url: "https://github.com/example/app",
              commit: SHA,
            },
            next: { at: "bot", agentId: BOT, by: "bot", action: "ask the bot" },
          },
        }),
      );
      expect(result).toMatchObject({ ok: true });
    });

    it("refuses a URL that carries credentials", () => {
      expect(
        pathsOf(
          bug({ refs: [{ label: "x", url: "https://user:pw@example.com/a" }] }),
        ),
      ).toContain("refs[0].url");
    });
  });
});

describe("slug, file name and expiry", () => {
  it("slugs the project, cut to 60 characters, and falls back to _general", () => {
    expect(inboxSlug("Nhân Viên Đức")).toBe("nhan-vien-duc");
    expect(inboxSlug("a".repeat(80))).toHaveLength(60);
    expect(inboxSlug("???")).toBe("_general");
    expect(inboxSlug("")).toBe("_general");
  });

  it("builds and parses file names", () => {
    const name = inboxFileName("2026-10-20T11:30:05Z", "bug", "abcd1234");
    expect(name).toBe("20261020T113005Z_bug_abcd1234.json");
    expect(parseInboxFileName(name)).toEqual({
      stamp: "20261020T113005Z",
      kind: "bug",
      id: "abcd1234",
    });
    expect(
      parseInboxFileName(".20261020T113005Z_bug_abcd1234.json.tmp"),
    ).toBeUndefined();
    expect(parseInboxFileName("notes.json")).toBeUndefined();
  });

  it("reads --expires-in from 1h to 30d", () => {
    expect(parseInboxExpiresIn("1h")).toEqual({ ok: true, ms: 3_600_000 });
    expect(parseInboxExpiresIn("30d")).toEqual({
      ok: true,
      ms: 30 * 86_400_000,
    });
    for (const bad of ["0h", "31d", "721h", "5m", "soon", ""])
      expect(parseInboxExpiresIn(bad).ok).toBe(false);
  });

  it("is expired from its expiresAt on", () => {
    const item = { expiresAt: "2026-10-20T12:00:00Z" };
    expect(isInboxExpired(item, Date.parse("2026-10-20T11:59:59Z"))).toBe(
      false,
    );
    expect(isInboxExpired(item, Date.parse("2026-10-20T12:00:00Z"))).toBe(true);
  });
});

describe("formatInboxMessage", () => {
  const item = { id: "abcd1234", project: "Demo  App" };

  it("builds the reply, answer and done messages", () => {
    expect(
      formatInboxMessage(item, { type: "reply", text: "Use the staging key." }),
    ).toBe("[inbox abcd1234 · Demo App · reply]\nUse the staging key.");
    expect(formatInboxMessage(item, { type: "answer", choice: "yes" })).toBe(
      "[inbox abcd1234 · Demo App · answer: yes]",
    );
    expect(
      formatInboxMessage(item, {
        type: "answer",
        choice: "yes",
        text: "ship it",
      }),
    ).toBe("[inbox abcd1234 · Demo App · answer: yes]\nship it");
    expect(
      formatInboxMessage(item, {
        type: "done",
        outcome: "fixed",
        reason: "patched",
        ref: "https://example.com/pr/1",
      }),
    ).toBe(
      "[inbox abcd1234 · Demo App · done: fixed]\npatched\nRef: https://example.com/pr/1",
    );
    expect(
      formatInboxMessage(item, { type: "done", outcome: "wont-fix" }),
    ).toBe("[inbox abcd1234 · Demo App · done: wont-fix]");
  });

  it("appends the runtime inside the bracket when given", () => {
    expect(formatInboxMessage(item, { type: "reply", text: "hi" }, "omp")).toBe(
      "[inbox abcd1234 · Demo App · reply · omp]\nhi",
    );
    expect(
      formatInboxMessage(
        item,
        { type: "answer", choice: "yes" },
        "Claude Code",
      ),
    ).toBe("[inbox abcd1234 · Demo App · answer: yes · Claude Code]");
    expect(
      formatInboxMessage(
        item,
        { type: "done", outcome: "fixed", reason: "patched" },
        "Codex",
      ),
    ).toBe("[inbox abcd1234 · Demo App · done: fixed · Codex]\npatched");
  });

  it("ends the bracket with the runtime and the session address when both are given", () => {
    expect(
      formatInboxMessage(
        item,
        { type: "reply", text: "hi" },
        "omp",
        "omp:abcd1234",
      ),
    ).toBe("[inbox abcd1234 · Demo App · reply · omp · omp:abcd1234]\nhi");
    expect(
      formatInboxMessage(
        item,
        { type: "done", outcome: "fixed" },
        "Codex",
        "codex:thread-1",
      ),
    ).toBe(
      "[inbox abcd1234 · Demo App · done: fixed · Codex · codex:thread-1]",
    );
  });

  it("leaves the address out when there is no runtime", () => {
    expect(
      formatInboxMessage(
        item,
        { type: "reply", text: "hi" },
        undefined,
        "omp:abcd1234",
      ),
    ).toBe("[inbox abcd1234 · Demo App · reply]\nhi");
  });

  it("knows every outcome", () => {
    expect(INBOX_OUTCOMES).toContain("expired");
  });
});

describe("module graph", () => {
  it("never reaches the Keychain, auth or the network from the inbox store and schema", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(join(dir, file), "utf8");
      for (const m of source.matchAll(/from "\.\/([\w-]+)\.js"/g))
        if (m[1]) walk(`${m[1]}.ts`);
    };
    for (const entry of ["inbox-store.ts", "inbox-schema.ts", "inbox-git.ts"])
      walk(entry);
    const forbidden = /keychain|auth-|gateway|server-transport|credential/;
    expect([...seen].filter((file) => forbidden.test(file))).toEqual([]);
    for (const file of seen)
      expect(readFileSync(join(dir, file), "utf8")).not.toMatch(
        /\/usr\/bin\/security|"security"/,
      );
  });
});
