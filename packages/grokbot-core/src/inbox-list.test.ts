import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxRow } from "./command-outputs-inbox.js";
import {
  BOT,
  type InboxWorld,
  inboxItem,
  inboxWorld,
  itemPath,
  NOW,
  type WorldOptions,
} from "./fixtures/inbox-world.js";
import { inboxStateStore } from "./inbox-state-store.js";
import { describeInboxItem } from "./inbox-text.js";
import type { InboxItem } from "./inbox-types.js";

let world: InboxWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const ago = (hours: number) =>
  `${new Date(NOW + hours * 3_600_000).toISOString().slice(0, 19)}Z`;

const ITEMS: readonly InboxItem[] = [
  inboxItem("aaaa1111", { hoursAgo: 5 }),
  inboxItem("bbbb2222", { hoursAgo: 1, severity: "critical" }),
  inboxItem("cccc3333", {
    hoursAgo: 2,
    kind: "task",
    ask: { doneWhen: "merged", blocking: "the release waits on it" },
  }),
  inboxItem("dddd4444", { hoursAgo: 9, project: "Other Site" }),
  inboxItem("eeee5555", { hoursAgo: 30, expiresAt: ago(-1) }),
  inboxItem("ffff6666", {
    hoursAgo: 3,
    work: {
      next: {
        at: "owner-computer",
        by: "session",
        machine: { id: "machine-1", label: "Example-Mac.local" },
        action: "check it",
      },
    },
  }),
];

async function start(options: WorldOptions = {}) {
  world = await inboxWorld({ items: ITEMS, ...options });
  return world;
}

const list = (
  w: InboxWorld,
  input: { project?: string; all?: boolean; handled?: boolean } = {},
) =>
  w.runner.run("inbox", {
    all: input.all ?? false,
    "include-handled": input.handled ?? false,
    json: false,
    ...(input.project !== undefined && { project: input.project }),
  });

const ids = (out: { items: readonly { id: string }[] }) =>
  out.items.map((i) => i.id);

describe("inbox list", () => {
  it("lists this folder's project, critical first, then blocking, then oldest", async () => {
    const out = await list(await start());
    expect(ids(out)).toEqual(["bbbb2222", "cccc3333", "aaaa1111", "ffff6666"]);
    expect(out.scope).toEqual({
      kind: "project",
      project: "Acme Web",
      source: "route",
    });
    expect(out).toMatchObject({
      hiddenExpired: 1,
      elsewhere: 1,
      projects: ["other-site"],
    });
  });

  it("lists every project with --all, a named project with --project", async () => {
    const w = await start();
    expect(ids(await list(w, { all: true }))).toEqual([
      "bbbb2222",
      "cccc3333",
      "dddd4444",
      "aaaa1111",
      "ffff6666",
    ]);
    const named = await list(w, { project: "other site" });
    expect(ids(named)).toEqual(["dddd4444"]);
    expect(named.scope.source).toBe("flag");
    await expect(
      list(w, { project: "Acme Web", all: true }),
    ).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("lists every project when the folder has no project route", async () => {
    const out = await list(await start({ cwd: "elsewhere" }));
    expect(out.scope).toEqual({ kind: "all", source: "all" });
    expect(out.items).toHaveLength(5);
  });

  it("lists open items only", async () => {
    const out = await list(
      await start({ closed: [inboxItem("zzzz9999", { status: "closed" })] }),
      { all: true },
    );
    expect(ids(out)).not.toContain("zzzz9999");
  });

  it("marks the item whose next step is on this computer, whatever the label's case or domain", async () => {
    const out = await list(await start());
    expect(out.items.filter((i) => i.yourTurnHere).map((i) => i.id)).toEqual([
      "ffff6666",
    ]);
    const other = await list(await start({ hostname: "another-mac" }));
    expect(other.items.some((i) => i.yourTurnHere)).toBe(false);
  });

  it("does not mark a step the bot takes itself, or an item already closed", async () => {
    const here = {
      at: "owner-computer",
      machine: { id: "machine-1", label: "Example-Mac.local" },
      action: "check it",
    } as const;
    const w = await start({
      items: [
        inboxItem("gggg7777", { work: { next: { ...here, by: "bot" } } }),
        inboxItem("hhhh8888", { work: { next: { ...here, by: "session" } } }),
      ],
      closed: [
        inboxItem("iiii9999", {
          status: "closed",
          work: { next: { ...here, by: "session" } },
        }),
      ],
    });
    const out = await list(w, { all: true });
    expect(out.items.filter((i) => i.yourTurnHere).map((i) => i.id)).toEqual([
      "hhhh8888",
    ]);
    const shown = await w.runner.run("inbox-show", {
      id: "iiii9999",
      json: false,
    });
    expect(shown.display.yourTurnHere).toBe(false);
  });

  it("names each item's bot from the roster", async () => {
    const out = await list(await start());
    expect(out.items[0]?.bot).toEqual({ agentId: BOT, name: "Primary Test" });
    expect(out.items[0]?.ageSeconds).toBe(3600);
  });

  it("hides what was handled here, and shows it again with --include-handled", async () => {
    const w = await start();
    await inboxStateStore(w.home).markHandled(
      "aaaa1111",
      { action: "reply", jobId: "job-1" },
      NOW,
    );
    const hidden = await list(w);
    expect(ids(hidden)).not.toContain("aaaa1111");
    expect(hidden.hiddenHandled).toBe(1);
    const shown = await list(w, { handled: true });
    expect(shown.items.find((i) => i.id === "aaaa1111")?.handled).toMatchObject(
      {
        action: "reply",
        jobId: "job-1",
      },
    );
    expect(shown.hiddenHandled).toBe(0);
  });

  it("fails with a fix hint when the state file is broken, and lists nothing", async () => {
    const w = await start();
    const { path } = inboxStateStore(w.home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not json");
    await expect(list(w)).rejects.toMatchObject({
      code: "safety",
      message: expect.stringContaining(path),
    });
  });

  it("shows an item of another schema major as needing a newer grokbot, and a broken file as unreadable", async () => {
    const w = await start();
    const newer = inboxItem("nnnn0001", { hoursAgo: 4 });
    w.files[itemPath(newer)] = JSON.stringify({
      ...newer,
      schema: "grokbot.inbox.item/v2",
    });
    const broken = inboxItem("uuuu0002", { hoursAgo: 4 });
    w.files[itemPath(broken)] = "not json";
    w.sync();
    const out = await list(w);
    expect(
      out.items.filter((i) => ["nnnn0001", "uuuu0002"].includes(i.id)),
    ).toMatchObject([
      { id: "nnnn0001", state: "needs-newer-grokbot", kind: "bug" },
      { id: "uuuu0002", state: "unreadable" },
    ]);
    expect(out.items.find((i) => i.id === "aaaa1111")?.state).toBe("ok");
  });

  it("reads the manifest and each item once while nothing changes", async () => {
    const w = await start();
    await list(w);
    const gets = w.box.gets.length;
    await list(w);
    expect(w.box.gets).toHaveLength(gets);
    w.files[itemPath(inboxItem("newn0003"))] = JSON.stringify(
      inboxItem("newn0003"),
    );
    w.sync();
    await list(w);
    // The manifest and the one new item.
    expect(w.box.gets).toHaveLength(gets + 2);
  });
});

describe("inbox show", () => {
  const show = (w: InboxWorld, id: string) =>
    w.runner.run("inbox-show", { id, json: false });

  it("returns the item untouched, with display fields beside it", async () => {
    const w = await start();
    const out = await show(w, "ffff6666");
    expect(out.item).toEqual(ITEMS[5]);
    expect(out.folder).toBe("open");
    expect(out.display).toMatchObject({
      bot: { agentId: BOT, name: "Primary Test" },
      ageSeconds: 3 * 3600,
      localFolder: w.project,
      yourTurnHere: true,
      expired: false,
      machine: {
        label: "Example-Mac.local",
        isThisComputer: true,
        lastSeenAt: new Date(NOW - 5 * 60_000).toISOString(),
      },
    });
  });

  it("shows a closed item and an expired one, and says so", async () => {
    const closed = inboxItem("zzzz9999", { status: "closed" });
    const w = await start({ closed: [closed] });
    expect(await show(w, "zzzz9999")).toMatchObject({ folder: "closed" });
    expect((await show(w, "eeee5555")).display.expired).toBe(true);
  });

  it("shows the schema of an item it cannot read instead of the item", async () => {
    const w = await start();
    const newer = inboxItem("nnnn0001");
    w.files[itemPath(newer)] = JSON.stringify({
      ...newer,
      schema: "grokbot.inbox.item/v2",
    });
    w.sync();
    const out = await show(w, "nnnn0001");
    expect(out.item).toBeUndefined();
    expect(out.needsNewerGrokbot).toBe("grokbot.inbox.item/v2");
  });

  it.each(["nope0000", "AAAA1111x", "../etc", ""])(
    "refuses the id %j",
    async (id) => {
      await expect(show(await start(), id)).rejects.toMatchObject({
        code: expect.stringMatching(/not-found|protocol/),
      });
    },
  );

  it("finds an id typed in capitals", async () => {
    expect((await show(await start(), "AAAA1111")).id).toBe("aaaa1111");
  });
});

describe("inbox items addressed to a session", () => {
  const MINE = "omp:mine-1234";
  const THEIRS = "omp:theirs-5678";
  const ADDRESSED: readonly InboxItem[] = [
    ...ITEMS,
    inboxItem("mine0001", { hoursAgo: 4, to: { session: MINE } }),
    inboxItem("thrs0002", { hoursAgo: 6, to: { session: THEIRS } }),
    inboxItem("mcrt0003", {
      hoursAgo: 8,
      severity: "critical",
      to: { session: MINE },
    }),
  ];
  const asMe: WorldOptions = {
    items: ADDRESSED,
    caller: "omp",
    env: { GROKBOT_SESSION: MINE },
  };
  const mark = (
    out: { items: readonly InboxRow[] },
    id: string,
  ): Pick<InboxRow, "toSession" | "forThisSession"> | undefined => {
    const row = out.items.find((i) => i.id === id);
    return (
      row && { toSession: row.toSession, forThisSession: row.forThisSession }
    );
  };

  it("marks items for this session and for another, and lists both", async () => {
    const out = await list(await start(asMe));
    expect(mark(out, "mine0001")).toEqual({
      toSession: MINE,
      forThisSession: true,
    });
    expect(mark(out, "thrs0002")).toEqual({
      toSession: THEIRS,
      forThisSession: false,
    });
    expect(mark(out, "aaaa1111")).toEqual({
      toSession: undefined,
      forThisSession: false,
    });
  });

  it("sorts items for this session right after the critical ones, ahead of blocked and older items", async () => {
    const out = await list(await start(asMe));
    expect(ids(out)).toEqual([
      "mcrt0003",
      "bbbb2222",
      "mine0001",
      "cccc3333",
      "thrs0002",
      "aaaa1111",
      "ffff6666",
    ]);
  });

  it("leaves the order as it is, and marks nothing as this session's, when the session is unknown", async () => {
    const out = await list(
      await start({ items: ADDRESSED, caller: "omp", env: {} }),
    );
    expect(ids(out)).toEqual([
      "mcrt0003",
      "bbbb2222",
      "cccc3333",
      "thrs0002",
      "aaaa1111",
      "mine0001",
      "ffff6666",
    ]);
    expect(out.items.some((i) => i.forThisSession)).toBe(false);
    expect(mark(out, "mine0001")?.toSession).toBe(MINE);
  });

  it("treats a person at a terminal as having no session", async () => {
    const out = await list(await start({ ...asMe, caller: "human" }));
    expect(out.items.some((i) => i.forThisSession)).toBe(false);
  });

  it("shows the address on the card, for this session or another", async () => {
    const w = await start(asMe);
    const show = (id: string) =>
      w.runner.run("inbox-show", { id, json: false });
    const mine = await show("mine0001");
    const theirs = await show("thrs0002");
    const plain = await show("aaaa1111");
    expect(mine.display).toMatchObject({
      toSession: MINE,
      forThisSession: true,
    });
    expect(theirs.display).toMatchObject({
      toSession: THEIRS,
      forThisSession: false,
    });
    expect(plain.display.toSession).toBeUndefined();
    expect(describeInboxItem(mine)).toContain(`For this session: ${MINE}\n`);
    expect(describeInboxItem(theirs)).toContain(
      `For another session: ${THEIRS}\n`,
    );
    expect(describeInboxItem(plain)).not.toContain("session:");
  });
});
