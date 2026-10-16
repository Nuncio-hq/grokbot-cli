import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STAFF_TEST } from "./fixtures/delegation-trace.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  delegateReplyRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";
import { type JobRecord, jobStore } from "./job-store.js";
import type { UsageEvent } from "./usage-log.js";
import { ownerMessageCounts, summarizeUsage } from "./usage-stats.js";

const base = {
  v: 1,
  hour: "2026-10-16T22",
  surface: "cli",
  duration: "<10s",
  flags: [],
  version: "0.1.2",
  os: "darwin",
} as const;
const ev = (over: Partial<UsageEvent>): UsageEvent =>
  ({
    ...base,
    command: "ask",
    client: "human",
    status: "done",
    ...over,
  }) as UsageEvent;

describe("summarizeUsage", () => {
  it("counts runs by caller, outcome, error and command, most used first", () => {
    const s = summarizeUsage([
      ev({ client: "claude-desktop", bot: "test" }),
      ev({ client: "claude-desktop", command: "send", status: "queued" }),
      ev({ status: "error", errorCode: "timeout" }),
      ev({ command: "agents", status: "ok", surface: "mcp" }),
    ]);
    expect(s).toEqual({
      total: 4,
      byClient: { "claude-desktop": 2, human: 2 },
      bySurface: { cli: 3, mcp: 1 },
      commands: [
        { command: "ask", count: 2, errors: 1 },
        { command: "agents", count: 1, errors: 0 },
        { command: "send", count: 1, errors: 0 },
      ],
      outcomes: { done: 1, queued: 1, error: 1, ok: 1 },
      errors: { timeout: 1 },
      durations: { "<10s": 4 },
      botKinds: { test: 1 },
    });
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-usage-stats-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ownerMessageCounts", () => {
  it("splits each bot's owner messages into sent through grokbot and the rest", async () => {
    const jobs = jobStore(dir);
    const job: JobRecord = {
      jobId: "job-1",
      agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09",
      sentMessageId: "m-cli",
      sentAtMs: 0,
      baselineUpdatedSeq: "0",
      generation: "0",
      state: { status: "done", finalReply: "x" },
    };
    await jobs.save(job);
    const old = userRow(100, "old", { clientNonce: "m-old", timestampMs: 10 });
    const { server } = fakeServer({
      calls: {
        ListGrokBotAgents: [
          {
            agents: [
              {
                id: "1",
                agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09",
                name: "Primary Test",
                kind: "GROK_BOT_AGENT_KIND_AGENT",
              },
            ],
          },
        ],
        ListGrokBotTranscriptEntries: [
          {
            entries: [
              old,
              userRow(101, "from grokbot", { clientNonce: "m-cli" }),
              userRow(102, "from the phone", { clientNonce: "m-app" }),
              userRow(103, "typed, no nonce"),
              delegateReplyRow(104, "PONG", STAFF_TEST),
              textReplyRow(105, "reply"),
            ],
          },
        ],
      },
    });
    expect(await ownerMessageCounts({ server, jobs, sinceMs: 1_000 })).toEqual([
      { bot: "Primary Test", viaGrokbot: 1, other: 2 },
    ]);
  });
});
