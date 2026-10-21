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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InboxHandled, inboxStateStore } from "./inbox-state-store.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const handled = (daysAgo: number): InboxHandled => ({
  handledAt: at(daysAgo),
  action: "reply",
  jobId: "job-1",
});
const record = { action: "reply", jobId: "job-1" } as const;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grokbot-inbox-state-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const store = () => inboxStateStore(home);
const writeRaw = async (text: string) => {
  await mkdir(dirname(store().path), { recursive: true });
  await writeFile(store().path, text);
};

describe("inboxStateStore", () => {
  it("reads as empty when the file does not exist", async () => {
    expect((await store().read()).size).toBe(0);
  });

  it("round-trips entries in a 0600 file", async () => {
    await store().markHandled(
      "bbbb2222",
      { action: "done", outcome: "fixed", jobId: "job-1" },
      NOW - DAY,
    );
    await store().markHandled("aaaa1111", record, NOW - 2 * DAY);
    const state = await store().read();
    expect([...state.keys()]).toEqual(["aaaa1111", "bbbb2222"]);
    expect(state.get("bbbb2222")).toEqual({
      ...handled(1),
      action: "done",
      outcome: "fixed",
    });
    expect((await stat(store().path)).mode & 0o777).toBe(0o600);
  });

  it("drops entries older than 60 days when it writes", async () => {
    await store().markHandled("stale222", record, NOW - 61 * DAY);
    await store().markHandled("fresh111", record, NOW - 59 * DAY);
    await store().markHandled("newest33", record, NOW);
    expect(JSON.parse(await readFile(store().path, "utf8"))).toEqual({
      handled: { fresh111: handled(59), newest33: handled(0) },
      delivered: {},
      noticeCheckedAt: {},
    });
  });

  it("keeps delivery and handled entries apart, each write leaving the other as it was", async () => {
    await store().markHandled("aaaa1111", record, NOW - DAY);
    await store().markDelivered(["bbbb2222", "cccc3333"], NOW);
    await store().markNoticeChecked("omp:s1", NOW + 1000);
    await store().markHandled("aaaa1111", record, NOW);
    const delivery = await store().readDelivery();
    expect([...delivery.delivered.keys()]).toEqual(["bbbb2222", "cccc3333"]);
    expect(delivery.delivered.get("bbbb2222")).toBe(
      new Date(NOW).toISOString(),
    );
    expect([...delivery.noticeCheckedAt]).toEqual([["omp:s1", NOW + 1000]]);
    expect([...(await store().read()).keys()]).toEqual(["aaaa1111"]);
  });

  it("drops deliveries older than 60 days when it writes", async () => {
    await store().markDelivered(["stale222"], NOW - 61 * DAY);
    await store().markDelivered(["fresh111"], NOW);
    expect([...(await store().readDelivery()).delivered.keys()]).toEqual([
      "fresh111",
    ]);
  });

  it("keeps a notice check per session, and drops one older than 60 days", async () => {
    await store().markNoticeChecked("omp:old", NOW - 61 * DAY);
    await store().markNoticeChecked("omp:a", NOW - 1000);
    await store().markNoticeChecked("omp:b", NOW);
    expect([...(await store().readDelivery()).noticeCheckedAt]).toEqual([
      ["omp:a", NOW - 1000],
      ["omp:b", NOW],
    ]);
  });

  it("adds a handled mark to what the file holds when it writes, not to what the caller read earlier", async () => {
    const first = store();
    const second = store();
    // Both callers read before either writes, as two replies in flight do.
    await first.read();
    await second.read();
    await first.markHandled("aaaa1111", record, NOW);
    await second.markHandled("bbbb2222", record, NOW);
    expect([...(await store().read()).keys()]).toEqual([
      "aaaa1111",
      "bbbb2222",
    ]);
  });

  it("loses no change when several run at once, and leaves nothing but the state file", async () => {
    const one = store();
    await Promise.all([
      one.markHandled("aaaa1111", record, NOW),
      one.markHandled("bbbb2222", record, NOW),
      one.markDelivered(["cccc3333"], NOW),
      one.markNoticeChecked("omp:s1", NOW),
    ]);
    expect([...(await store().read()).keys()]).toEqual([
      "aaaa1111",
      "bbbb2222",
    ]);
    const delivery = await store().readDelivery();
    expect([...delivery.delivered.keys()]).toEqual(["cccc3333"]);
    expect([...delivery.noticeCheckedAt.keys()]).toEqual(["omp:s1"]);
    expect(await readdir(dirname(one.path))).toEqual([
      "grokbot-cli-inbox-state.json",
    ]);
  });

  it("changes nothing when the file cannot be loaded, so deliveries are never wiped", async () => {
    const text = `{"delivered":{"cccc3333":"${at(1)}"},"handled":{"a":1}}`;
    await writeRaw(text);
    await expect(
      store().markHandled("aaaa1111", record, NOW),
    ).rejects.toMatchObject({ code: "safety" });
    await expect(
      store().markDelivered(["bbbb2222"], NOW),
    ).rejects.toMatchObject({ code: "safety" });
    expect(await readFile(store().path, "utf8")).toBe(text);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["a list", "[]"],
    ["an entry that is not an object", '{"handled":{"a":1}}'],
    [
      "a time that is not a time",
      '{"handled":{"a":{"handledAt":"yesterday","action":"reply","jobId":"j"}}}',
    ],
    [
      "an unknown action",
      `{"handled":{"a":{"handledAt":"${at(1)}","action":"shrug","jobId":"j"}}}`,
    ],
    [
      "no job id",
      `{"handled":{"a":{"handledAt":"${at(1)}","action":"reply"}}}`,
    ],
    ["a delivery that is not a time", '{"delivered":{"a":"later"}}'],
  ])("fails closed on %s, naming the file", async (_name, text) => {
    await writeRaw(text);
    await expect(store().read()).rejects.toMatchObject({
      code: "safety",
      message: expect.stringContaining(store().path),
    });
  });

  it.each([
    ["a single time instead of one per session", `"${at(1)}"`],
    ["a session whose time is not a time", '{"omp:a":"later"}'],
  ])(
    "ignores notice times it cannot read (%s): they only throttle",
    async (_name, raw) => {
      await writeRaw(
        `{"delivered":{"cccc3333":"${at(1)}"},"noticeCheckedAt":${raw}}`,
      );
      const delivery = await store().readDelivery();
      expect([...delivery.delivered.keys()]).toEqual(["cccc3333"]);
      expect(delivery.noticeCheckedAt.size).toBe(0);
    },
  );
});
