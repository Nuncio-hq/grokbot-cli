import {
  mkdir,
  mkdtemp,
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
    await store().write(
      new Map([
        [
          "bbbb2222",
          { ...handled(1), action: "done" as const, outcome: "fixed" },
        ],
        ["aaaa1111", handled(2)],
      ]),
      NOW,
    );
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
    await store().write(
      new Map([
        ["fresh111", handled(59)],
        ["stale222", handled(61)],
      ]),
      NOW,
    );
    expect(JSON.parse(await readFile(store().path, "utf8"))).toEqual({
      handled: { fresh111: handled(59) },
      delivered: {},
    });
  });

  it("keeps delivery and handled entries apart, each write leaving the other as it was", async () => {
    await store().write(new Map([["aaaa1111", handled(1)]]), NOW);
    await store().markDelivered(["bbbb2222", "cccc3333"], NOW);
    await store().markNoticeChecked(NOW + 1000);
    await store().write(new Map([["aaaa1111", handled(0)]]), NOW);
    const delivery = await store().readDelivery();
    expect([...delivery.delivered.keys()]).toEqual(["bbbb2222", "cccc3333"]);
    expect(delivery.delivered.get("bbbb2222")).toBe(
      new Date(NOW).toISOString(),
    );
    expect(delivery.noticeCheckedAtMs).toBe(NOW + 1000);
    expect([...(await store().read()).keys()]).toEqual(["aaaa1111"]);
  });

  it("drops deliveries older than 60 days when it writes", async () => {
    await store().markDelivered(["stale222"], NOW - 61 * DAY);
    await store().markDelivered(["fresh111"], NOW);
    expect([...(await store().readDelivery()).delivered.keys()]).toEqual([
      "fresh111",
    ]);
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
    ["a notice time that is not a time", '{"noticeCheckedAt":"later"}'],
  ])("fails closed on %s, naming the file", async (_name, text) => {
    await writeRaw(text);
    await expect(store().read()).rejects.toMatchObject({
      code: "safety",
      message: expect.stringContaining(store().path),
    });
  });
});
