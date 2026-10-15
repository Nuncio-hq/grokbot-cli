import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import {
  AGENT,
  ASK,
  botAfterSend,
  finishedBot,
  onlyJob,
  RUNNING,
  TRACE_ROWS,
} from "./command-runner-test-bot.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { TRACE_MESSAGE_ID } from "./fixtures/delegation-trace.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { userRow } from "./fixtures/wire-entries.js";
import { type JobRecord, type JobStore, jobStore } from "./job-store.js";

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-runner-resume-"));
  jobs = jobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAVED: JobRecord = {
  jobId: "job-7",
  agentId: AGENT,
  sentMessageId: TRACE_MESSAGE_ID,
  sentAtMs: 1_791_948_600_000,
  baselineUpdatedSeq: "141",
  generation: "0",
  state: { status: "done", finalReply: "RESULT: PONG" },
};
const WAIT = { job: "job-7", timeout: 1, json: false };

const busyOnLaterTurn = {
  calls: {
    ListGrokBotTranscriptEntries: [
      {
        entries: [
          TRACE_ROWS.echo,
          TRACE_ROWS.finalReply,
          userRow(148, "Now do something else."),
        ],
      },
    ],
    ListGrokBotAgentStatuses: [RUNNING],
  },
};
const http502 = {
  calls: {
    ListGrokBotTranscriptEntries: () => {
      throw new GrokBotError(
        "http",
        "ListGrokBotTranscriptEntries failed with HTTP 502",
      );
    },
  },
};

describe("wait on a job saved as done", () => {
  it.each([
    ["the bot is busy on a later turn", busyOnLaterTurn],
    ["the server answers HTTP 502", http502],
  ])(
    "returns the saved reply with no network call when %s",
    async (_, script) => {
      await jobs.save(SAVED);
      const file = join(dir, "job-7.json");
      const before = await readFile(file, "utf8");
      const { server, log } = fakeServer(script);
      const out = await createCommandRunner({ server, jobs }).run("wait", WAIT);
      expect([out, log, await readFile(file, "utf8")]).toEqual([
        {
          jobId: "job-7",
          agentId: AGENT,
          outcome: { status: "done", finalReply: "RESULT: PONG", replies: [] },
        },
        [],
        before,
      ]);
    },
  );
});

describe("wait on a job saved as failed", () => {
  it("waits again, since the failure may have been transient", async () => {
    await jobs.save({
      ...SAVED,
      state: { status: "failed", error: "HTTP 502" },
    });
    const { server } = finishedBot(SAVED);
    const out = await createCommandRunner({ server, jobs }).run("wait", WAIT);
    expect([out.outcome.status, (await onlyJob(jobs)).state]).toEqual([
      "done",
      { status: "done", finalReply: "RESULT: PONG" },
    ]);
  });
});

describe("a job whose send was never confirmed", () => {
  it("is saved as sending before the send, and wait finds the echo later", async () => {
    let atSend: unknown[] = [];
    let messageId = "";
    const { server } = botAfterSend([], {
      calls: {
        SendGrokBotUserMessage: async (body: JsonObject) => {
          messageId = String(body.messageId);
          atSend = (await jobs.list()).map((j) => [
            j.sentMessageId,
            j.baselineUpdatedSeq,
            j.state,
          ]);
          throw new TypeError("fetch failed");
        },
      },
    });
    const error = await createCommandRunner({ server, jobs })
      .run("ask", ASK)
      .catch((e: unknown) => e);
    const job = await onlyJob(jobs);
    expect([(error as Error).message, atSend, job.state]).toEqual([
      "fetch failed",
      [[messageId, "141", { status: "sending" }]],
      { status: "sending" },
    ]);

    const later = finishedBot(job);
    const out = await createCommandRunner({ server: later.server, jobs }).run(
      "wait",
      { job: job.jobId, timeout: 5, json: false },
    );
    expect([
      out.outcome.status === "done" && out.outcome.finalReply,
      (await onlyJob(jobs)).state,
    ]).toEqual([
      "RESULT: PONG",
      { status: "done", finalReply: "RESULT: PONG" },
    ]);
  });

  it("times out as pending when no echo ever appears", async () => {
    await jobs.save({ ...SAVED, state: { status: "sending" } });
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [] }],
        ListGrokBotAgentStatuses: [{ statuses: [{ agentId: AGENT }] }],
      },
    });
    const out = await createCommandRunner({ server, jobs }).run("wait", WAIT);
    expect([out.outcome, (await onlyJob(jobs)).state]).toEqual([
      {
        status: "pending",
        reason: "no Done verdict within 1000 ms (last: running, awaiting-echo)",
      },
      { status: "pending" },
    ]);
  }, 5_000);
});
