import { afterEach, describe, expect, it } from "vitest";
import {
  BOT,
  type InboxWorld,
  inboxItem,
  inboxWorld,
  NOW,
  OTHER_BOT,
  RUN_ROW,
  type WorldOptions,
} from "./fixtures/inbox-world.js";
import { inboxStateStore } from "./inbox-state-store.js";
import type { InboxItem } from "./inbox-types.js";

let world: InboxWorld | undefined;

/** The sent texts, with the random job handle of an agent's bracket shown as `<job>`. */
const texts = (w: InboxWorld) =>
  w.sent.map((s) => s.text.replace(/job [0-9a-f]{8}\]/, "job <job>]"));
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const ITEMS: readonly InboxItem[] = [
  inboxItem("aaaa1111"),
  inboxItem("qqqq0001", {
    kind: "question",
    ask: { choices: ["yes", "no"] },
  }),
  inboxItem("dddd0001", { kind: "decision" }),
  inboxItem("rrrr0002", { replyTo: { agentId: OTHER_BOT } }),
  inboxItem("lost0003", { from: { agentId: BOT, run: "run-gone", cwd: "/w" } }),
  inboxItem("old00004", { hoursAgo: 80, expiresAt: "2026-10-18T00:00:00Z" }),
  // A bot that left no run: a hand-written file, which the reader accepts.
  inboxItem("norun006", {
    from: { agentId: BOT, cwd: "/w" } as InboxItem["from"],
  }),
];

async function start(options: WorldOptions = {}) {
  world = await inboxWorld({
    items: ITEMS,
    closed: [inboxItem("clsd0005", { status: "closed" })],
    ...options,
  });
  return world;
}

const reply = (w: InboxWorld, id: string, text?: string, choice?: string) =>
  w.runner.run("inbox-reply", {
    id,
    json: false,
    ...(text !== undefined && { text }),
    ...(choice !== undefined && { choice }),
  });

const done = (
  w: InboxWorld,
  id: string,
  input: { outcome: string; reason?: string; ref?: string },
) => w.runner.run("inbox-done", { id, json: false, ...input });

describe("inbox-reply", () => {
  it("sends the contract message to the item's bot as a reply to the row of the run that left it", async () => {
    const w = await start();
    const out = await reply(w, "aaaa1111", "Looking into it now");
    expect(w.sent).toEqual([
      {
        agentId: BOT,
        text: "[inbox aaaa1111 · Acme Web · reply]\nLooking into it now",
        replyToId: RUN_ROW,
      },
    ]);
    expect(out).toMatchObject({
      id: "aaaa1111",
      action: "reply",
      replyToId: RUN_ROW,
      queued: false,
      agent: { agentId: BOT },
    });
    expect(out.jobId).toMatch(/\S/);
  });

  it("records the item as handled on this computer, with the job id", async () => {
    const w = await start();
    const out = await reply(w, "aaaa1111", "On it");
    const state = await inboxStateStore(w.home).read();
    expect(state.get("aaaa1111")).toEqual({
      handledAt: new Date(NOW).toISOString(),
      action: "reply",
      jobId: out.jobId,
    });
    const listed = await w.runner.run("inbox", {
      all: true,
      "include-handled": false,
      json: false,
    });
    expect(listed.items.map((i) => i.id)).not.toContain("aaaa1111");
  });

  it("keeps every item handled when replies are in flight together", async () => {
    const w = await start();
    await Promise.all([
      reply(w, "aaaa1111", "first"),
      reply(w, "qqqq0001", "second"),
      done(w, "rrrr0002", { outcome: "fixed" }),
    ]);
    expect([...(await inboxStateStore(w.home).read()).keys()].sort()).toEqual([
      "aaaa1111",
      "qqqq0001",
      "rrrr0002",
    ]);
  });

  it("answers a question with a choice, with or without text", async () => {
    const withText = await start();
    await reply(withText, "qqqq0001", "because it is faster", "yes");
    expect(withText.sent.map((s) => s.text)).toEqual([
      "[inbox qqqq0001 · Acme Web · answer: yes]\nbecause it is faster",
    ]);
    expect(
      (await inboxStateStore(withText.home).read()).get("qqqq0001")?.action,
    ).toBe("answer");
    await withText.close();
    const bare = await start();
    await reply(bare, "qqqq0001", undefined, "no");
    expect(bare.sent.map((s) => s.text)).toEqual([
      "[inbox qqqq0001 · Acme Web · answer: no]",
    ]);
  });

  it("queues a second message while the bot has not answered the first", async () => {
    const w = await start();
    expect((await reply(w, "aaaa1111", "first")).queued).toBe(false);
    expect((await reply(w, "qqqq0001", "second")).queued).toBe(true);
    expect(w.sent.map((s) => s.text)).toHaveLength(1);
  });

  it("refuses a choice the question does not offer, a choice on another kind, and an empty reply", async () => {
    const w = await start();
    await expect(
      reply(w, "qqqq0001", undefined, "maybe"),
    ).rejects.toMatchObject({
      code: "safety",
      message: expect.stringContaining("yes | no"),
    });
    await expect(reply(w, "aaaa1111", "x", "yes")).rejects.toMatchObject({
      code: "safety",
    });
    await expect(reply(w, "aaaa1111")).rejects.toMatchObject({
      code: "ambiguous",
    });
    expect(w.sent).toEqual([]);
  });

  it("goes to replyTo's bot instead, and links no row when the run is not in that bot's chat", async () => {
    const w = await start();
    await reply(w, "rrrr0002", "Over to you");
    expect(w.sent).toEqual([
      {
        agentId: OTHER_BOT,
        text: "[inbox rrrr0002 · Acme Web · reply]\nOver to you",
        replyToId: undefined,
      },
    ]);
  });

  it("sends a plain message when the run is no longer in the chat", async () => {
    const w = await start();
    const out = await reply(w, "lost0003", "Hello");
    expect(w.sent[0]).toMatchObject({ agentId: BOT, replyToId: undefined });
    expect(out.replyToId).toBeUndefined();
  });

  it("sends a plain message when the item names no run, not a reply to a row that has none", async () => {
    const w = await start();
    const out = await reply(w, "norun006", "Hello");
    expect(w.sent[0]).toMatchObject({ agentId: BOT, replyToId: undefined });
    expect(out.replyToId).toBeUndefined();
  });

  it("keeps the contract bracket and adds the runtime inside it, with no second tag", async () => {
    const asReply = await start({ caller: "omp" });
    await reply(asReply, "aaaa1111", "Looking into it now");
    expect(texts(asReply)).toEqual([
      "[inbox aaaa1111 · Acme Web · reply · omp · job <job>]\nLooking into it now",
    ]);
    await asReply.close();
    const asAnswer = await start({ caller: "omp" });
    await reply(asAnswer, "qqqq0001", undefined, "yes");
    expect(texts(asAnswer)).toEqual([
      "[inbox qqqq0001 · Acme Web · answer: yes · omp · job <job>]",
    ]);
  });

  it("names no runtime for a person typing", async () => {
    const w = await start({ caller: "human" });
    await reply(w, "aaaa1111", "On it");
    expect(w.sent.map((s) => s.text)).toEqual([
      "[inbox aaaa1111 · Acme Web · reply]\nOn it",
    ]);
  });

  it("ends the bracket with the runtime and the session address when grokbot knows it", async () => {
    const asReply = await start({
      caller: "omp",
      env: { GROKBOT_SESSION: "omp:b1b2c3d4" },
    });
    await reply(asReply, "aaaa1111", "Looking into it now");
    expect(texts(asReply)).toEqual([
      "[inbox aaaa1111 · Acme Web · reply · omp · omp:b1b2c3d4 · job <job>]\nLooking into it now",
    ]);
    await asReply.close();
    const asAnswer = await start({
      caller: "omp",
      env: { GROKBOT_SESSION: "omp:b1b2c3d4" },
    });
    await reply(asAnswer, "qqqq0001", undefined, "yes");
    expect(texts(asAnswer)).toEqual([
      "[inbox qqqq0001 · Acme Web · answer: yes · omp · omp:b1b2c3d4 · job <job>]",
    ]);
  });

  it("names no session for a person typing, even with GROKBOT_SESSION set", async () => {
    const w = await start({
      caller: "human",
      env: { GROKBOT_SESSION: "omp:b1b2c3d4" },
    });
    await reply(w, "aaaa1111", "On it");
    expect(w.sent.map((s) => s.text)).toEqual([
      "[inbox aaaa1111 · Acme Web · reply]\nOn it",
    ]);
  });

  it.each([
    ["a decision, which only the owner answers", "dddd0001", "safety"],
    ["a closed item", "clsd0005", "safety"],
    ["an expired item", "old00004", "safety"],
    ["an id nothing carries", "nope0000", "not-found"],
  ])("refuses %s and sends nothing", async (_name, id, code) => {
    const w = await start();
    await expect(reply(w, id, "hi")).rejects.toMatchObject({ code });
    expect(w.sent).toEqual([]);
    expect((await inboxStateStore(w.home).read()).size).toBe(0);
  });

  it("sends nothing when the state file is broken", async () => {
    const w = await start();
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { path } = inboxStateStore(w.home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[]");
    await expect(reply(w, "aaaa1111", "hi")).rejects.toMatchObject({
      code: "safety",
    });
    expect(w.sent).toEqual([]);
  });
});

describe("inbox-done", () => {
  it("sends the closing message with reason and link, and records the outcome", async () => {
    const w = await start();
    const out = await done(w, "aaaa1111", {
      outcome: "fixed",
      reason: "Patched the retry path",
      ref: "https://example.com/pr/1",
    });
    expect(w.sent).toEqual([
      {
        agentId: BOT,
        text: "[inbox aaaa1111 · Acme Web · done: fixed]\nPatched the retry path\nRef: https://example.com/pr/1",
        replyToId: RUN_ROW,
      },
    ]);
    expect(out).toMatchObject({ id: "aaaa1111", closedAs: "fixed" });
    expect((await inboxStateStore(w.home).read()).get("aaaa1111")).toEqual({
      handledAt: new Date(NOW).toISOString(),
      action: "done",
      outcome: "fixed",
      jobId: out.jobId,
    });
  });

  it("sends the bare message when no reason or link is given", async () => {
    const w = await start();
    await done(w, "aaaa1111", { outcome: "wont-fix" });
    expect(w.sent[0]?.text).toBe(
      "[inbox aaaa1111 · Acme Web · done: wont-fix]",
    );
  });

  it("adds the runtime's display name to the closing message too", async () => {
    const w = await start({ caller: "claude-code" });
    await done(w, "aaaa1111", { outcome: "fixed", reason: "Patched" });
    expect(texts(w)[0]).toBe(
      "[inbox aaaa1111 · Acme Web · done: fixed · Claude Code · job <job>]\nPatched",
    );
  });

  it("ends the closing bracket with the runtime and the session address when grokbot knows it", async () => {
    const w = await start({
      caller: "claude-code",
      env: { GROKBOT_SESSION: "claude-code:c0ffee-1234" },
    });
    await done(w, "aaaa1111", { outcome: "fixed", reason: "Patched" });
    expect(texts(w)[0]).toBe(
      "[inbox aaaa1111 · Acme Web · done: fixed · Claude Code · claude-code:c0ffee-1234 · job <job>]\nPatched",
    );
  });

  it.each([
    ["expired, which is grokbot's own", { outcome: "expired" }],
    ["an unknown outcome", { outcome: "shipped" }],
    [
      "a link that is not https",
      { outcome: "fixed", ref: "http://example.com" },
    ],
    [
      "two links",
      { outcome: "fixed", ref: "https://a.example https://b.example" },
    ],
    [
      "a reason past 300 characters",
      { outcome: "fixed", reason: "x".repeat(301) },
    ],
  ])("refuses %s", async (_name, input) => {
    const w = await start();
    await expect(done(w, "aaaa1111", input)).rejects.toMatchObject({
      code: "safety",
    });
    expect(w.sent).toEqual([]);
  });

  it.each([
    ["a decision", "dddd0001"],
    ["a closed item", "clsd0005"],
    ["an unknown id", "nope0000"],
  ])("refuses %s", async (_name, id) => {
    const w = await start();
    await expect(done(w, id, { outcome: "done" })).rejects.toBeDefined();
    expect(w.sent).toEqual([]);
  });
});
