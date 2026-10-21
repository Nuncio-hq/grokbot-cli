import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { RunEvent } from "./command-runner-contract.js";
import {
  AGENT,
  ASK,
  botAfterSend,
  liveFrame,
  onlyJob,
  RUNNING,
  rowsFrame,
  TRACE_ROWS,
} from "./command-runner-test-bot.js";
import { GrokBotError } from "./contracts.js";
import { hangUntilAborted } from "./fixtures/fake-server.js";
import { type JobStore, jobStore } from "./job-store.js";

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-runner-ask-"));
  jobs = jobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const verdicts = (events: RunEvent[]) =>
  events.flatMap((e) => {
    if (e.type !== "verdict") return [];
    const { verdict } = e;
    return [verdict.status === "running" ? verdict.reason : verdict.status];
  });

describe("ask", () => {
  it("returns the delegated final reply #147 RESULT: PONG and saves the job as done", async () => {
    const { server } = botAfterSend([TRACE_ROWS.progressNote], {
      calls: { ListGrokBotAgentStatuses: [RUNNING] },
      streams: [
        [
          rowsFrame([TRACE_ROWS.delegation, TRACE_ROWS.sentNote]),
          liveFrame(),
          rowsFrame([TRACE_ROWS.employeeReply]),
          liveFrame({ isRunning: true }),
          rowsFrame([TRACE_ROWS.finalReply]),
          liveFrame(),
        ],
      ],
    });
    const events: RunEvent[] = [];
    let savedAtDispatch: unknown;
    const out = await createCommandRunner({ server, jobs }).run("ask", ASK, {
      onEvent: (e) => {
        events.push(e);
        if (e.type !== "dispatched") return;
        const file = join(dir, `${e.jobId}.json`);
        savedAtDispatch = JSON.parse(readFileSync(file, "utf8")).state;
      },
    });

    expect([events[0], savedAtDispatch]).toEqual([
      { type: "dispatched", jobId: out.jobId, agentId: AGENT },
      { status: "pending" },
    ]);
    expect(
      out.outcome.status === "done" && [
        out.agent.name,
        out.outcome.finalReply,
        out.outcome.replies.map((r) => r.seq),
      ],
    ).toEqual(["Trace Bot", "RESULT: PONG", ["143", "145", "147"]]);
    expect(out.next).toBeUndefined();
    expect(await jobs.load(out.jobId)).toMatchObject({
      agentId: AGENT,
      baselineUpdatedSeq: "141",
      state: { status: "done", finalReply: "RESULT: PONG" },
    });
    expect(verdicts(events)).toEqual([
      "target-active",
      "pending-delegation",
      "awaiting-final-reply",
      "target-active",
      "done",
    ]);
  });

  it("saves a non-timeout wait error as failed and rethrows it", async () => {
    const { server } = botAfterSend([], {
      calls: { ListGrokBotAgentStatuses: [RUNNING] },
      streams: [[{ cleared: { agentId: AGENT, newGeneration: "1" } }]],
    });
    const error = await createCommandRunner({ server, jobs })
      .run("ask", ASK)
      .catch((e: unknown) => e);
    const message = `transcript of ${AGENT} was cleared while waiting`;
    expect([
      error instanceof GrokBotError && error.code,
      (error as Error).message,
      (await onlyJob(jobs)).state,
    ]).toEqual(["not-found", message, { status: "failed", error: message }]);
  });

  it("emits no dispatched event and keeps no job when the send is refused", async () => {
    const { server } = botAfterSend([], {
      calls: {
        SendGrokBotUserMessage: [{ delivery: "GROK_BOT_DELIVERY_REFUSED" }],
      },
    });
    const events: RunEvent[] = [];
    const error = await createCommandRunner({ server, jobs })
      .run("ask", ASK, { onEvent: (e) => events.push(e) })
      .catch((e: unknown) => e);
    expect([(error as Error).message, events, await jobs.list()]).toEqual([
      "SendGrokBotUserMessage refused the message: delivery GROK_BOT_DELIVERY_REFUSED",
      [],
      [],
    ]);
  });

  it("keeps the job pending when the caller aborts, so wait can resume it", async () => {
    const controller = new AbortController();
    const { server } = botAfterSend([], {
      calls: { ListGrokBotAgentStatuses: [RUNNING] },
      streams: [() => hangUntilAborted([], controller.signal)],
    });
    const error = await createCommandRunner({ server, jobs })
      .run("ask", ASK, {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "dispatched") controller.abort(new Error("ctrl-c"));
        },
      })
      .catch((e: unknown) => e);
    expect([(error as Error).message, (await onlyJob(jobs)).state]).toEqual([
      "ctrl-c",
      { status: "pending" },
    ]);
  });
});

describe("setup-bots", () => {
  const SETUP = { timeout: 1, json: false } as const;
  const PRIMARY_IS_TRACE_BOT = {
    GetGrokBotUserRuntimeSettings: [{ settings: { mainAgentId: AGENT } }],
  };
  const steps = (next: string | undefined, jobId: string) => ({
    reply: next?.includes(`grokbot reply ${jobId}`),
    inboxWait: next?.includes(`grokbot inbox wait --job ${jobId.slice(0, 8)}`),
    inboxDone: next?.includes("grokbot inbox-done <id> --outcome done"),
    waitForReply: next?.includes(`grokbot wait ${jobId}`),
  });

  it("returns the primary Bot's reply with the setup steps: reply to the project list, wait for the Setup check item, close it", async () => {
    const { server } = botAfterSend([TRACE_ROWS.progressNote], {
      calls: {
        ListGrokBotAgentStatuses: [RUNNING],
        ...PRIMARY_IS_TRACE_BOT,
      },
      streams: [
        [
          rowsFrame([TRACE_ROWS.delegation, TRACE_ROWS.sentNote]),
          liveFrame(),
          rowsFrame([TRACE_ROWS.employeeReply]),
          liveFrame({ isRunning: true }),
          rowsFrame([TRACE_ROWS.finalReply]),
          liveFrame(),
        ],
      ],
    });
    const events: RunEvent[] = [];
    const out = await createCommandRunner({ server, jobs }).run(
      "setup-bots",
      SETUP,
      { onEvent: (e) => events.push(e) },
    );
    expect([out.agent.agentId, out.outcome.status, events[0]]).toEqual([
      AGENT,
      "done",
      { type: "dispatched", jobId: out.jobId, agentId: AGENT },
    ]);
    expect(steps(out.next, out.jobId)).toEqual({
      reply: true,
      inboxWait: true,
      inboxDone: true,
      waitForReply: false,
    });
    expect(await jobs.load(out.jobId)).toMatchObject({
      state: { status: "done", finalReply: "RESULT: PONG" },
    });
  });

  it("carries the same steps while the reply is not in, after the wait for it", async () => {
    const { server } = botAfterSend([TRACE_ROWS.progressNote], {
      calls: {
        ListGrokBotAgentStatuses: [RUNNING],
        ...PRIMARY_IS_TRACE_BOT,
      },
    });
    const out = await createCommandRunner({ server, jobs }).run(
      "setup-bots",
      SETUP,
    );
    expect(out.outcome.status).toBe("pending");
    expect(steps(out.next, out.jobId)).toEqual({
      reply: true,
      inboxWait: true,
      inboxDone: true,
      waitForReply: true,
    });
    expect(out.next?.indexOf("grokbot wait")).toBeLessThan(
      out.next?.indexOf("grokbot reply") ?? 0,
    );
    expect((await onlyJob(jobs)).state).toEqual({ status: "pending" });
  }, 5_000);
});
