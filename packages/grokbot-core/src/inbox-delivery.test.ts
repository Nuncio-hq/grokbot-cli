import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InboxWorld,
  inboxItem,
  inboxWorld,
  itemPath,
  type WorldOptions,
} from "./fixtures/inbox-world.js";
import { inboxStateStore } from "./inbox-state-store.js";
import type { InboxItem } from "./inbox-types.js";

const ME = "omp:me000001";
const THEM = "omp:them0002";
const AS_ME: WorldOptions = { caller: "omp", env: { GROKBOT_SESSION: ME } };

let world: InboxWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function start(options: WorldOptions = {}) {
  world = await inboxWorld({ ...AS_ME, ...options });
  return world;
}

/** Adds an item the way the cloud sync does: a file, then a new manifest etag. */
function leave(w: InboxWorld, item: InboxItem) {
  w.files[itemPath(item)] = JSON.stringify(item, null, 2);
  w.sync();
}

const wait = (w: InboxWorld, job: string[] = [], timeout = "0s") =>
  w.runner.run("inbox-wait", { job, timeout, json: false });
const check = (w: InboxWorld) => w.runner.run("inbox-check", { json: false });
const ids = (out: { items: readonly { id: string }[] }) =>
  out.items.map((i) => i.id);

const forMe = (id: string, extra: Partial<InboxItem> = {}) =>
  inboxItem(id, { to: { session: ME }, ...extra });

describe("the header names the job", () => {
  const send = (w: InboxWorld) =>
    w.runner.run("send", { text: "hello", json: false });

  it("ends an agent's header with the job and keeps the session on the job record", async () => {
    const w = await start();
    const out = await send(w);
    expect(w.sent[0]?.text).toBe(
      `[Project: Acme Web · Runtime: omp · Session: ${ME} · Job: ${out.jobId.slice(0, 8)}] hello`,
    );
    expect((await w.jobs.load(out.jobId))?.session).toBe(ME);
  });

  it("leaves a person's header without a runtime, session or job", async () => {
    const w = await start({ caller: "human" });
    await send(w);
    expect(w.sent[0]?.text).toBe("[Project: Acme Web] hello");
  });
});

describe("items for this session's jobs", () => {
  it("marks an item whose to.job is a job sent from this session, and shows the job", async () => {
    const w = await start({
      items: [
        inboxItem("jobm0001", { to: { job: "a1b2c3d4" } }),
        inboxItem("jobo0002", { to: { job: "ffffffff" } }),
      ],
    });
    const { jobId } = await w.runner.run("send", { text: "hi", json: false });
    await w.jobs.save({
      ...(await w.jobs.load(jobId)),
      jobId: "a1b2c3d4-0000-4000-8000-000000000000",
      session: ME,
    } as never);
    const list = await w.runner.run("inbox", {
      all: false,
      "include-handled": false,
      json: false,
    });
    const row = (id: string) => list.items.find((i) => i.id === id);
    expect(row("jobm0001")).toMatchObject({
      toJob: "a1b2c3d4",
      forThisSession: true,
    });
    expect(row("jobo0002")).toMatchObject({
      toJob: "ffffffff",
      forThisSession: false,
    });
    const shown = await w.runner.run("inbox-show", {
      id: "jobm0001",
      json: false,
    });
    expect(shown.display).toMatchObject({
      toJob: "a1b2c3d4",
      forThisSession: true,
    });
  });
});

describe("inbox wait", () => {
  it("returns the open items addressed to this session and ignores the others", async () => {
    const w = await start({
      items: [
        forMe("mine0001"),
        inboxItem("thrs0002", { to: { session: THEM } }),
        inboxItem("plan0003"),
      ],
    });
    const out = await wait(w);
    expect(ids(out)).toEqual(["mine0001"]);
    expect(out).toMatchObject({ timedOut: false, watching: { session: ME } });
    expect(out.items[0]).toMatchObject({
      kind: "bug",
      severity: "normal",
      project: "Acme Web",
      title: "Item mine0001",
      doneWhen: "the page loads",
      bot: { name: "Primary Test" },
    });
  });

  it("does not return an item twice, though the inbox still lists it", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    expect(ids(await wait(w))).toEqual(["mine0001"]);
    expect(await wait(w)).toMatchObject({ items: [], timedOut: true });
    const list = await w.runner.run("inbox", {
      all: false,
      "include-handled": false,
      json: false,
    });
    expect(ids(list)).toContain("mine0001");
    expect(
      (await inboxStateStore(w.home).readDelivery()).delivered.has("mine0001"),
    ).toBe(true);
  });

  it("returns an item that arrives while it waits, within the next check", async () => {
    const w = await start({ inboxPollMs: 20 });
    const waiting = wait(w, [], "5s");
    // Once the first look at the store found nothing, the sync brings the item.
    await vi.waitFor(() =>
      expect(w.log.some((c) => c.method === "StatSandBoxStoreObject")).toBe(
        true,
      ),
    );
    leave(w, forMe("late0001"));
    expect(ids(await waiting)).toEqual(["late0001"]);
  });

  it("times out with no items when nothing is addressed to it", async () => {
    const w = await start({ items: [inboxItem("plan0003")] });
    expect(await wait(w)).toMatchObject({
      items: [],
      timedOut: true,
      waitedSeconds: 0,
    });
  });

  it("watches the jobs this session sent, and only those, without --job", async () => {
    const w = await start();
    const { jobId } = await w.runner.run("send", { text: "hi", json: false });
    const handle = jobId.slice(0, 8);
    leave(w, inboxItem("mine0001", { to: { job: handle } }));
    leave(w, inboxItem("othr0002", { to: { job: "ffffffff" } }));
    const out = await wait(w);
    expect(ids(out)).toEqual(["mine0001"]);
    expect(out.watching.jobs).toEqual([handle]);
  });

  it("watches the --job values given, a full job id or its first 8 characters", async () => {
    const w = await start({
      items: [
        inboxItem("full0001", { to: { job: "1f2e3d4c" } }),
        inboxItem("part0002", { to: { job: "5a6b7c8d" } }),
        inboxItem("none0003", { to: { job: "99999999" } }),
      ],
    });
    const out = await wait(w, [
      "1F2E3D4C-0000-4000-8000-000000000000",
      "5a6b7c8d",
    ]);
    expect(ids(out)).toEqual(["full0001", "part0002"]);
  });

  it("fails at once, saying how to pass --job, with no session and no job to watch", async () => {
    const w = await start({
      caller: "omp",
      env: {},
      items: [forMe("mine0001")],
    });
    await expect(wait(w)).rejects.toMatchObject({
      message: expect.stringContaining("--job"),
    });
    expect(await wait(w, ["1f2e3d4c"])).toMatchObject({ timedOut: true });
  });

  it.each([
    ["a job that is not an id", { job: ["nope"], timeout: "0s" }],
    ["a timeout that is not a duration", { job: [], timeout: "soon" }],
  ])("refuses %s", async (_, input) => {
    const w = await start();
    await expect(
      w.runner.run("inbox-wait", { ...input, json: false }),
    ).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("skips items already handled from here and expired ones", async () => {
    const w = await start({
      items: [
        forMe("done0001"),
        forMe("expd0002", { expiresAt: "2026-10-19T00:00:00Z" }),
        forMe("live0003"),
      ],
    });
    await w.runner.run("inbox-done", {
      id: "done0001",
      outcome: "fixed",
      json: false,
    });
    expect(ids(await wait(w))).toEqual(["live0003"]);
  });

  it("is limited to the longest wait the host allows", async () => {
    const w = await start({ maxInboxWaitSeconds: 0 });
    expect(await wait(w, [], "1h")).toMatchObject({
      items: [],
      timedOut: true,
    });
  });
});

describe("inbox check", () => {
  it("shows each item once and then says nothing", async () => {
    const w = await start({ items: [forMe("mine0001"), forMe("mine0002")] });
    expect(ids(await check(w))).toEqual(["mine0001", "mine0002"]);
    expect((await check(w)).items).toEqual([]);
    leave(w, forMe("mine0003"));
    expect(ids(await check(w))).toEqual(["mine0003"]);
  });

  it("is quiet, not an error, with nothing to watch", async () => {
    const w = await start({
      caller: "omp",
      env: {},
      items: [forMe("mine0001")],
    });
    expect((await check(w)).items).toEqual([]);
  });

  it("does not return what an inbox wait delivered", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    await wait(w);
    expect((await check(w)).items).toEqual([]);
  });
});

describe("catch-up notices", () => {
  const agents = (w: InboxWorld) => w.runner.run("agents", { json: false });

  it("rides on another command, and the item counts as delivered", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    const out = await agents(w);
    expect(out.inboxNotice?.items.map((i) => i.id)).toEqual(["mine0001"]);
    expect((await check(w)).items).toEqual([]);
  });

  it("looks at most once a minute", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    expect((await agents(w)).inboxNotice).toBeDefined();
    leave(w, forMe("mine0002"));
    w.clock.ms += 59_000;
    expect((await agents(w)).inboxNotice).toBeUndefined();
    w.clock.ms += 2_000;
    const later = await agents(w);
    expect(later.inboxNotice?.items.map((i) => i.id)).toEqual(["mine0002"]);
    w.clock.ms += 120_000;
    expect((await agents(w)).inboxNotice).toBeUndefined();
  });

  it("looks once a minute for each session, so one session's check never hides another's items", async () => {
    const env: Record<string, string> = { GROKBOT_SESSION: ME };
    const w = await start({ env });
    expect((await agents(w)).inboxNotice).toBeUndefined();
    leave(w, inboxItem("them0001", { to: { session: THEM } }));
    leave(w, forMe("mine0002"));
    w.clock.ms += 1_000;
    env.GROKBOT_SESSION = THEM;
    const theirs = await agents(w);
    expect(theirs.inboxNotice?.items.map((i) => i.id)).toEqual(["them0001"]);
    env.GROKBOT_SESSION = ME;
    expect((await agents(w)).inboxNotice).toBeUndefined();
    w.clock.ms += 60_000;
    const mine = await agents(w);
    expect(mine.inboxNotice?.items.map((i) => i.id)).toEqual(["mine0002"]);
  });

  it("leaves its items undelivered when it runs out of time before it marks them", async () => {
    const controller = new AbortController();
    const marking: Promise<void>[] = [];
    const w = await start({
      items: [forMe("mine0001")],
      // The time-box runs out as the check is written, before the items are marked.
      inboxState: (home) => {
        const real = inboxStateStore(home);
        return {
          ...real,
          async markNoticeChecked(session, nowMs) {
            await real.markNoticeChecked(session, nowMs);
            controller.abort();
          },
          markDelivered(delivered, nowMs) {
            const marked = real.markDelivered(delivered, nowMs);
            marking.push(marked);
            return marked;
          },
        };
      },
    });
    const out = await w.runner.run(
      "agents",
      { json: false },
      { signal: controller.signal },
    );
    expect(out.inboxNotice).toBeUndefined();
    // What the notice does after it has answered still counts, so let it finish first.
    await tick();
    await Promise.all(marking);
    expect(ids(await check(w))).toEqual(["mine0001"]);
  });

  it("lets the next command try again when a lookup fails", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    w.box.state.withheld.add("manifest.json");
    expect((await agents(w)).inboxNotice).toBeUndefined();
    w.box.state.withheld.delete("manifest.json");
    const next = await agents(w);
    expect(next.inboxNotice?.items.map((i) => i.id)).toEqual(["mine0001"]);
  });

  it("is not added to the inbox commands themselves", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    const out = await w.runner.run("inbox", {
      all: false,
      "include-handled": false,
      json: false,
    });
    expect("inboxNotice" in out).toBe(false);
    expect(ids(await wait(w))).toEqual(["mine0001"]);
  });

  it("names nothing for a person, or when no session or job is known", async () => {
    const person = await start({ caller: "human", items: [forMe("mine0001")] });
    expect((await agents(person)).inboxNotice).toBeUndefined();
    await person.close();
    const nobody = await start({
      caller: "omp",
      env: {},
      items: [forMe("mine0001")],
    });
    expect((await agents(nobody)).inboxNotice).toBeUndefined();
  });

  it("never fails the command, whatever goes wrong with the check", async () => {
    const w = await start({ items: [forMe("mine0001")] });
    const { path } = inboxStateStore(w.home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not json");
    const out = await agents(w);
    expect(out.agents.map((a) => a.name)).toEqual([
      "Primary Test",
      "Staff Test",
    ]);
    expect(out.inboxNotice).toBeUndefined();
  });
});

describe("the next step after a send", () => {
  it("is on send, with the job and its handle", async () => {
    const w = await start();
    const out = await w.runner.run("send", { text: "hi", json: false });
    expect(out.next).toContain(`grokbot wait ${out.jobId}`);
    expect(out.next).toContain(
      `grokbot inbox wait --job ${out.jobId.slice(0, 8)}`,
    );
    expect(out.next).toContain("in the background");
  });
});
