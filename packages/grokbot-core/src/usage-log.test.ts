import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  durationBucket,
  localHour,
  type UsageEvent,
  usageLog,
} from "./usage-log.js";

const event = (hour: string, command = "ask"): UsageEvent => ({
  v: 1,
  hour,
  command: command as UsageEvent["command"],
  surface: "cli",
  client: "human",
  status: "done",
  duration: "<10s",
  flags: ["agent", "text"],
  version: "0.1.2",
  os: "darwin",
});

let dir: string;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "grokbot-usage-")), "usage");
});
afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

describe("usageLog", () => {
  it("appends one line per event to this month's private file and reads it back", async () => {
    const log = usageLog(dir);
    const oct = new Date(2026, 9, 16, 22).getTime();
    await log.append(event("2026-10-16T22"), oct);
    await log.append(event("2026-10-16T23", "send"), oct);
    expect(await readdir(dir)).toEqual(["2026-10.jsonl"]);
    expect((await stat(join(dir, "2026-10.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await log.read()).map((e) => e.command)).toEqual(["ask", "send"]);
    expect((await log.read("2026-10-16T23")).map((e) => e.command)).toEqual([
      "send",
    ]);
  });

  it("drops months older than about 90 days when it appends", async () => {
    await mkdir(dir, { recursive: true });
    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"])
      await writeFile(join(dir, `${month}.jsonl`), "");
    await usageLog(dir).append(
      event("2026-10-01T09"),
      new Date(2026, 9, 1, 9).getTime(),
    );
    expect((await readdir(dir)).sort()).toEqual([
      "2026-08.jsonl",
      "2026-09.jsonl",
      "2026-10.jsonl",
    ]);
  });

  it("skips a torn or foreign line and keeps the rest", async () => {
    const log = usageLog(dir);
    await log.append(event("2026-10-16T22"), new Date(2026, 9, 16).getTime());
    await appendFile(join(dir, "2026-10.jsonl"), '{"v":1,"hour":\n{"x":1}\n');
    expect(await log.read()).toHaveLength(1);
  });

  it("reads nothing when the folder does not exist yet", async () => {
    expect(await usageLog(dir).read()).toEqual([]);
  });
});

describe("buckets", () => {
  it.each([
    [999, "<1s"],
    [9_999, "<10s"],
    [59_999, "<1m"],
    [299_999, "<5m"],
    [300_000, ">=5m"],
  ] as const)("puts %d ms in %s", (ms, bucket) => {
    expect(durationBucket(ms)).toBe(bucket);
  });

  it("keeps only the local hour", () => {
    expect(localHour(new Date(2026, 9, 6, 8, 59, 30).getTime())).toBe(
      "2026-10-06T08",
    );
  });
});
