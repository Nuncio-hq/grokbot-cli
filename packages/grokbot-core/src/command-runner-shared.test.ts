import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  PROBE_A_ID,
  PROBE_B_ID,
  PROBE_TRACE,
  SPIKE_IN_ORDER,
  TICKET_A_ID,
  TICKET_B_ID,
} from "./fixtures/shared-run-traces.js";
import type { WireEntry } from "./fixtures/wire-entries.js";
import { type JobRecord, type JobStore, jobStore } from "./job-store.js";

const AGENT = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const IDLE = { statuses: [{ agentId: AGENT }] };
const job = (
  jobId: string,
  sentMessageId: string,
  baselineUpdatedSeq: string,
  botBusyAtSend?: boolean,
): JobRecord => ({
  jobId,
  agentId: AGENT,
  agentName: "Primary Test",
  sentMessageId,
  sentAtMs: 1_792_069_710_000,
  baselineUpdatedSeq,
  generation: "0",
  ...(botBusyAtSend !== undefined && { botBusyAtSend }),
  state: { status: "pending" },
});
const idleBot = (rows: readonly WireEntry[]) =>
  fakeServer({
    calls: {
      ListGrokBotTranscriptEntries: [{ entries: rows }],
      ListGrokBotAgentStatuses: [IDLE],
    },
  });
const WAIT = { timeout: 5, json: false } as const;

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-runner-shared-"));
  jobs = jobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("wait on two jobs one bot run answered together", () => {
  it("replays the 15 Oct spike: neither ticket is saved done with the other's answer", async () => {
    await jobs.save(job("job-a", TICKET_A_ID, "168", false));
    await jobs.save(job("job-b", TICKET_B_ID, "170", true));
    const runner = createCommandRunner({
      server: idleBot(SPIKE_IN_ORDER).server,
      jobs,
    });
    const a = await runner.run("wait", { job: "job-a", ...WAIT });
    const b = await runner.run("wait", { job: "job-b", ...WAIT });
    expect([a.agentName, a.outcome.status, b.outcome.status]).toEqual([
      "Primary Test",
      "ambiguous",
      "ambiguous",
    ]);
    const saved = await jobs.list();
    expect(saved.map((j) => [j.jobId, j.state.status])).toEqual([
      ["job-a", "ambiguous"],
      ["job-b", "ambiguous"],
    ]);
  });

  it("replays the 16 Oct probe: A reads B's idle record but is still tied to B", async () => {
    await jobs.save(job("job-a", PROBE_A_ID, "179", false));
    await jobs.save(job("job-b", PROBE_B_ID, "180", false));
    const runner = createCommandRunner({
      server: idleBot(PROBE_TRACE).server,
      jobs,
    });
    const a = await runner.run("wait", { job: "job-a", ...WAIT });
    expect(
      a.outcome.status === "ambiguous" && [
        a.outcome.reason,
        a.outcome.replyText,
      ],
    ).toEqual([
      "the bot may have answered this message in one run together with message #181",
      "BETA",
    ]);
  });

  it("returns a saved ambiguous job offline", async () => {
    await jobs.save({
      ...job("job-a", TICKET_A_ID, "168"),
      state: { status: "ambiguous", reason: "shared", replyText: "A\n\nB" },
    });
    const { server, log } = fakeServer({});
    const out = await createCommandRunner({ server, jobs }).run("wait", {
      job: "job-a",
      ...WAIT,
    });
    expect([out.outcome, log]).toEqual([
      {
        status: "ambiguous",
        reason: "shared",
        replyText: "A\n\nB",
        replies: [],
      },
      [],
    ]);
  });
});
