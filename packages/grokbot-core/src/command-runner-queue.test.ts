import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { RunEvent } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  QUEUE_AGENT as AGENT,
  type QueueBotOptions,
  queueBot,
} from "./fixtures/queue-bot.js";
import { type JobStore, jobStore } from "./job-store.js";

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-runner-queue-"));
  jobs = jobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(options?: QueueBotOptions) {
  const bot = queueBot(options);
  const runner = createCommandRunner({ server: bot.server, jobs });
  const send = (text: string, now = false) =>
    runner.run("send", { text, agent: AGENT, now, json: false });
  const wait = (
    job: string,
    timeout = 5,
    onEvent?: (event: RunEvent) => void,
  ) =>
    runner.run(
      "wait",
      { job, timeout, json: false },
      onEvent ? { onEvent } : {},
    );
  const edit = (job: string, text: string) =>
    runner.run("edit", { job, text, json: false });
  return { bot, send, wait, edit };
}

const replyOf = (outcome: { status: string; finalReply?: string }) =>
  outcome.status === "done" ? outcome.finalReply : outcome.status;

describe("the sender decides: --now and edit", () => {
  it("sends a --now message while the bot is busy, recorded as busy, and leaves earlier queued ones in place", async () => {
    const { bot, send } = setup();
    await send("task A");
    const b = await send("task B");
    const c = await send("also for A", true);
    expect([
      c.queued,
      (await jobs.load(c.jobId))?.botBusyAtSend,
      (await jobs.load(b.jobId))?.state.status,
      bot.sends(),
    ]).toEqual([false, true, "queued", ["task A", "also for A"]]);
  });

  it("edits a queued message, sends the new text once the bot is free, and refuses after it went out", async () => {
    const { bot, send, edit } = setup();
    await send("task A");
    const b = await send("task B");
    const whileBusy = await edit(b.jobId, "task B, v2");
    bot.finish("RESULT A");
    const whenFree = await edit(b.jobId, "task B, v3");
    const late = await edit(b.jobId, "task B, v4").catch((e: unknown) => e);
    expect([
      whileBusy.queued,
      whenFree.queued,
      late instanceof GrokBotError,
      bot.sends(),
    ]).toEqual([true, false, true, ["task A", "task B, v3"]]);
  });
});

describe("one message per bot at a time", () => {
  it("queues B while A runs, sends it when A's turn ends, and gives each its own reply", async () => {
    const { bot, send, wait } = setup();
    const a = await send("task A");
    const b = await send("task B");
    expect([a.queued, b.queued, bot.sends()]).toEqual([
      false,
      true,
      ["task A"],
    ]);

    bot.finish("RESULT A");
    const waitedA = await wait(a.jobId);
    const sentB = await jobs.load(b.jobId);
    expect([
      replyOf(waitedA.outcome),
      bot.sends(),
      sentB?.state.status,
      sentB?.botBusyAtSend,
      sentB?.text,
      sentB?.baselineUpdatedSeq,
    ]).toEqual([
      "RESULT A",
      ["task A", "task B"],
      "pending",
      false,
      undefined,
      "141",
    ]);

    bot.finish("RESULT B");
    expect(replyOf((await wait(b.jobId)).outcome)).toBe("RESULT B");
  });

  it("sends a queued message from its own wait once the bot is free", async () => {
    const { bot, send, wait } = setup({
      autoReply: (text) => (text === "task B" ? "RESULT B" : undefined),
    });
    const a = await send("task A");
    const b = await send("task B");
    setTimeout(() => bot.finish("RESULT A"), 100);
    const events: RunEvent[] = [];
    const waitedB = await wait(b.jobId, 10, (e) => events.push(e));
    expect([
      replyOf(waitedB.outcome),
      bot.sends(),
      events.find((e) => e.type === "queued"),
      (await jobs.load(a.jobId))?.state.status,
    ]).toEqual([
      "RESULT B",
      ["task A", "task B"],
      { type: "queued", jobId: b.jobId, agentId: AGENT, ahead: 0 },
      "pending",
    ]);
  });

  it("times out while queued as pending, keeps the job queued, and hands off nothing on a pending turn", async () => {
    const { bot, send, wait } = setup();
    const a = await send("task A");
    const b = await send("task B");
    const [waitedA, waitedB] = [await wait(a.jobId, 1), await wait(b.jobId, 1)];
    expect([
      waitedA.outcome.status,
      waitedB.outcome,
      (await jobs.load(b.jobId))?.state.status,
      bot.sends(),
    ]).toEqual([
      "pending",
      {
        status: "pending",
        reason:
          "Primary Test is busy with earlier work, so the message is queued and not sent yet",
        queued: true,
      },
      "queued",
      ["task A"],
    ]);
  });

  it("sends the oldest queued message first when a later send finds the bot free", async () => {
    const { bot, send } = setup();
    await send("task A");
    const b = await send("task B");
    bot.finish("RESULT A");
    const c = await send("task C");
    expect([
      bot.sends(),
      (await jobs.load(b.jobId))?.state.status,
      c.queued,
    ]).toEqual([["task A", "task B"], "pending", true]);
  });

  it("hands off once when two waits see the same turn end", async () => {
    const { bot, send } = setup();
    const a = await send("task A");
    await send("task B");
    bot.finish("RESULT A");
    const other = createCommandRunner({ server: bot.server, jobs });
    const input = { job: a.jobId, timeout: 5, json: false };
    await Promise.all([
      other.run("wait", input),
      createCommandRunner({ server: bot.server, jobs }).run("wait", input),
    ]);
    expect(bot.sends()).toEqual(["task A", "task B"]);
  });

  it("treats a message sent moments ago as busy until its echo shows", async () => {
    const { bot, send } = setup({ echoes: false });
    const a = await send("task A");
    const b = await send("task B");
    expect([a.queued, b.queued, bot.sends()]).toEqual([
      false,
      true,
      ["task A"],
    ]);
  });
});

describe("a queued message the server refuses", () => {
  it("is saved failed, its wait throws the refusal, and the next message goes out", async () => {
    const { bot, send, wait } = setup({ refuse: (t) => t === "task B" });
    const a = await send("task A");
    const b = await send("task B");
    const c = await send("task C");
    bot.finish("RESULT A");
    await wait(a.jobId);
    const error = await wait(b.jobId).catch((e: unknown) => e);
    expect([
      bot.sends(),
      (await jobs.load(b.jobId))?.state,
      (await jobs.load(c.jobId))?.state.status,
      error instanceof GrokBotError && error.code,
      (error as Error).message,
    ]).toEqual([
      ["task A", "task B", "task C"],
      {
        status: "failed",
        error: "SendGrokBotUserMessage refused the message: The bot is paused.",
        notSent: true,
      },
      "pending",
      "protocol",
      "SendGrokBotUserMessage refused the message: The bot is paused.",
    ]);
  });

  it("throws a saved not-sent failure on wait without touching the network", async () => {
    const a = await setup().send("task A");
    const saved = await jobs.load(a.jobId);
    if (!saved) throw new Error("no job");
    const state = {
      status: "failed",
      error: "refused",
      notSent: true,
    } as const;
    await jobs.save({ ...saved, state });
    const { server, log } = fakeServer({});
    const error = await createCommandRunner({ server, jobs })
      .run("wait", { job: a.jobId, timeout: 5, json: false })
      .catch((e: unknown) => e);
    expect([(error as Error).message, log]).toEqual(["refused", []]);
  });

  it("leaves no job when send itself is refused", async () => {
    const { send } = setup({ refuse: () => true });
    const error = await send("task A").catch((e: unknown) => e);
    expect([error instanceof GrokBotError, await jobs.list()]).toEqual([
      true,
      [],
    ]);
  });
});
