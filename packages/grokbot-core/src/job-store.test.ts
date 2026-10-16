import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { DEFAULT_JOBS_DIR, type JobRecord, jobStore } from "./job-store.js";

const job: JobRecord = {
  jobId: "job-1",
  agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09",
  sentMessageId: "04365d83-0000-4000-8000-000000000000",
  sentAtMs: 1_791_948_600_000,
  baselineUpdatedSeq: "141",
  generation: "0",
  state: { status: "pending" },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-jobs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("jobStore", () => {
  it("defaults to ~/.grokbot/jobs", () => {
    expect(DEFAULT_JOBS_DIR).toBe(join(homedir(), ".grokbot", "jobs"));
  });

  it("saves a job as <dir>/<jobId>.json with only the known keys", async () => {
    await jobStore(dir).save({
      ...job,
      token: "should-not-persist",
    } as JobRecord);
    const onDisk = JSON.parse(await readFile(join(dir, "job-1.json"), "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual([
      "agentId",
      "baselineUpdatedSeq",
      "generation",
      "jobId",
      "sentAtMs",
      "sentMessageId",
      "state",
    ]);
    expect(onDisk).toEqual(job);
  });

  it("round-trips through load and creates the directory on first save", async () => {
    const store = jobStore(join(dir, "nested", "jobs"));
    await store.save(job);
    expect(await store.load("job-1")).toEqual(job);
    expect(await store.load("missing")).toBeNull();
  });

  it("saving the same record twice leaves one identical file and no temp files", async () => {
    const store = jobStore(dir);
    await store.save(job);
    const first = await readFile(join(dir, "job-1.json"), "utf8");
    await store.save(job);
    expect(await readdir(dir)).toEqual(["job-1.json"]);
    expect(await readFile(join(dir, "job-1.json"), "utf8")).toBe(first);
  });

  it("overwrites state on a later save", async () => {
    const store = jobStore(dir);
    await store.save(job);
    await store.save({
      ...job,
      state: { status: "done", finalReply: "RESULT: PONG" },
    });
    expect((await store.load("job-1"))?.state).toEqual({
      status: "done",
      finalReply: "RESULT: PONG",
    });
  });

  it("round-trips a job saved as sending, before its message is sent", async () => {
    const store = jobStore(dir);
    const sending: JobRecord = { ...job, state: { status: "sending" } };
    await store.save(sending);
    expect(await store.load("job-1")).toEqual(sending);
  });

  it("never moves a done job to another state", async () => {
    const store = jobStore(dir);
    const done: JobRecord = {
      ...job,
      state: { status: "done", finalReply: "RESULT: PONG" },
    };
    await store.save(done);
    await store.save(job);
    await store.save({
      ...job,
      state: { status: "failed", error: "HTTP 502" },
    });
    await store.save({
      ...job,
      state: { status: "done", finalReply: "later" },
    });
    expect(await store.load("job-1")).toEqual(done);
  });

  it("round-trips the agent name and busy-at-send record, and keeps an ambiguous job final", async () => {
    const store = jobStore(dir);
    const ambiguous: JobRecord = {
      ...job,
      agentName: "Primary Test",
      botBusyAtSend: true,
      state: {
        status: "ambiguous",
        reason: "shared run",
        replyText: "A\n\nB",
      },
    };
    await store.save(ambiguous);
    await store.save({ ...job, state: { status: "done", finalReply: "B" } });
    expect(await store.load("job-1")).toEqual(ambiguous);
  });

  it("loads a job saved before agentName and botBusyAtSend existed", async () => {
    await writeFile(join(dir, "job-1.json"), JSON.stringify(job));
    const loaded = await jobStore(dir).load("job-1");
    expect([loaded?.agentName, loaded?.botBusyAtSend]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("removes a job, and removing a missing job is a no-op", async () => {
    const store = jobStore(dir);
    await store.save(job);
    await store.remove("job-1");
    await store.remove("job-1");
    expect([await store.load("job-1"), await readdir(dir)]).toEqual([null, []]);
  });

  it("lists saved jobs by jobId, skipping stray temp and foreign files", async () => {
    const store = jobStore(dir);
    await store.save({ ...job, jobId: "job-b" });
    await store.save({ ...job, jobId: "job-a" });
    await writeFile(join(dir, ".job-c.json.123.tmp"), "{");
    await writeFile(join(dir, "notes.txt"), "x");
    expect((await store.list()).map((j) => j.jobId)).toEqual([
      "job-a",
      "job-b",
    ]);
    expect(await jobStore(join(dir, "absent")).list()).toEqual([]);
  });

  it("rejects job ids that could escape the directory", async () => {
    await expect(
      jobStore(dir).save({ ...job, jobId: "../evil" }),
    ).rejects.toThrow(GrokBotError);
    await expect(jobStore(dir).load("a/b")).rejects.toThrow(GrokBotError);
  });

  it("rejects a corrupt job file with a protocol error", async () => {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ jobId: "bad" }));
    await expect(jobStore(dir).load("bad")).rejects.toMatchObject({
      code: "protocol",
    });
  });

  it("rejects a job file whose state is not one it knows", async () => {
    const unknown = { ...job, jobId: "odd", state: { status: "queued" } };
    await writeFile(join(dir, "odd.json"), JSON.stringify(unknown));
    await expect(jobStore(dir).load("odd")).rejects.toMatchObject({
      code: "protocol",
      message: `corrupt job file ${join(dir, "odd.json")}`,
    });
  });
});
