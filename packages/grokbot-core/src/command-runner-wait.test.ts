import { mkdtemp, rm } from "node:fs/promises";
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
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { sendMessageRow } from "./fixtures/wire-entries.js";
import { type JobStore, jobStore } from "./job-store.js";

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-runner-wait-"));
  jobs = jobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("wait resumes a job saved by an earlier ask", () => {
  it("ask times out to pending, then wait in a new runner finds RESULT: PONG", async () => {
    const first = botAfterSend([TRACE_ROWS.progressNote], {
      calls: { ListGrokBotAgentStatuses: [RUNNING] },
    });
    const asked = await createCommandRunner({
      server: first.server,
      jobs,
    }).run("ask", ASK);
    expect([asked.outcome, (await onlyJob(jobs)).state]).toEqual([
      {
        status: "pending",
        reason: "no Done verdict within 1000 ms (last: running, target-active)",
      },
      { status: "pending" },
    ]);

    // Not settled: the next step names both waits, the second by the job's 8-character handle.
    expect(asked.next).toContain(`grokbot wait ${asked.jobId}`);
    expect(asked.next).toContain(
      `grokbot inbox wait --job ${asked.jobId.slice(0, 8)}`,
    );

    const later = finishedBot(await onlyJob(jobs));
    const waited = await createCommandRunner({
      server: later.server,
      jobs: jobStore(dir),
    }).run("wait", { job: asked.jobId, timeout: 5, json: false });
    // Settled: no hint.
    expect(waited.next).toBeUndefined();
    expect([
      waited.jobId,
      waited.agentId,
      waited.outcome.status === "done" && waited.outcome.finalReply,
      (await onlyJob(jobs)).state,
    ]).toEqual([
      asked.jobId,
      AGENT,
      "RESULT: PONG",
      { status: "done", finalReply: "RESULT: PONG" },
    ]);
    expect(later.log.map((c) => c.method)).not.toContain(
      "SendGrokBotUserMessage",
    );
  }, 5_000);

  it("saves awaiting-approval, and wait re-checks it once the card resolves", async () => {
    const card = sendMessageRow(143, {
      type: "widget",
      ask: { status: "pending" },
    });
    const { server } = botAfterSend([card], {
      calls: {
        ListGrokBotAgentStatuses: [
          { statuses: [{ agentId: AGENT, live: { awaiting: "Pick one" } }] },
        ],
      },
    });
    const asked = await createCommandRunner({ server, jobs }).run("ask", ASK);
    expect(asked.next).toContain(`grokbot wait ${asked.jobId}`);
    expect([asked.outcome.status, (await onlyJob(jobs)).state]).toEqual([
      "awaiting-approval",
      { status: "awaiting-approval", reason: "Pick one" },
    ]);

    const later = finishedBot(await onlyJob(jobs));
    const waited = await createCommandRunner({
      server: later.server,
      jobs,
    }).run("wait", { job: asked.jobId, timeout: 5, json: false });
    expect([waited.outcome.status, (await onlyJob(jobs)).state]).toEqual([
      "done",
      { status: "done", finalReply: "RESULT: PONG" },
    ]);
  });
});

describe("wait", () => {
  it("names the job id when no job is saved under it", async () => {
    const { server, log } = fakeServer({});
    const error = await createCommandRunner({ server, jobs })
      .run("wait", { job: "job-404", timeout: 1, json: false })
      .catch((e: unknown) => e);
    expect([
      error instanceof GrokBotError && error.code,
      (error as Error).message.includes('"job-404"'),
      log,
    ]).toEqual(["not-found", true, []]);
  });
});
