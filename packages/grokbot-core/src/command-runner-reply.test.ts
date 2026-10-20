import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { CommandRunnerOptions } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import {
  QUEUE_AGENT as AGENT,
  type QueueBotOptions,
  queueBot,
} from "./fixtures/queue-bot.js";
import { type JobStore, jobStore } from "./job-store.js";

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "grokbot-runner-reply-")));
  jobs = jobStore(join(dir, "jobs"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(options?: QueueBotOptions, runner?: CommandRunnerOptions) {
  const bot = queueBot(options);
  const run = createCommandRunner({
    server: bot.server,
    jobs,
    cwd: dir,
    projectRoutes: async () => new Map(),
    ...runner,
  });
  const send = (text: string) =>
    run.run("send", { text, agent: AGENT, json: false });
  const wait = (job: string, timeout = 5) =>
    run.run("wait", { job, timeout, json: false });
  const reply = (input: {
    job?: string;
    text: string;
    to?: string;
    timeout?: number;
  }) => run.run("reply", { timeout: 5, json: false, agent: AGENT, ...input });
  return { bot, send, wait, reply };
}

const done = (outcome: { status: string; finalReply?: string }) =>
  outcome.status === "done" ? outcome.finalReply : outcome.status;

/** The seeded transcript's one older bot message: seq 139, before any message of ours. */
const OLDER = "entry-139";

describe("reply", () => {
  it("answers the job's last bot message and waits for the bot's answer like ask", async () => {
    const { bot, send, wait, reply } = setup({
      autoReply: (text) => (text === "yes" ? "DONE" : undefined),
    });
    const a = await send("task A");
    bot.finish("first message");
    bot.finish("QUESTION?");
    await wait(a.jobId);

    const out = await reply({ job: a.jobId, text: "yes" });
    const [, sent] = bot.sentBodies();
    expect([
      done(out.outcome),
      out.replyToId,
      out.jobId === a.jobId,
      sent?.text,
      sent?.replyToId,
      (await jobs.load(out.jobId))?.replyToId,
    ]).toEqual(["DONE", "entry-142", false, "yes", "entry-142", "entry-142"]);
  });

  it("sends no replyToId on a plain send", async () => {
    const { bot, send } = setup();
    await send("task A");
    expect(bot.sentBodies().map((body) => "replyToId" in body)).toEqual([
      false,
    ]);
  });

  it("--to answers the given entry instead of the job's last bot message", async () => {
    const { bot, send, wait, reply } = setup({
      autoReply: (text) => (text === "about the old one" ? "OK" : undefined),
    });
    const a = await send("task A");
    bot.finish("QUESTION?");
    await wait(a.jobId);

    const out = await reply({
      job: a.jobId,
      text: "about the old one",
      to: OLDER,
    });
    expect([done(out.outcome), bot.sentBodies()[1]?.replyToId]).toEqual([
      "OK",
      OLDER,
    ]);
  });

  it("--to without a job answers an entry of the bot that --agent names", async () => {
    const { bot, reply } = setup({ autoReply: () => "OK" });
    const out = await reply({ text: "re: older", to: OLDER });
    expect([
      done(out.outcome),
      out.agent.agentId,
      bot.sentBodies()[0]?.replyToId,
    ]).toEqual(["OK", AGENT, OLDER]);
  });

  it("keeps replyToId on a reply queued behind a busy bot, and sends it with the entry once the bot is free", async () => {
    const { bot, send, wait, reply } = setup({
      autoReply: (text) => (text === "re: older" ? "OK" : undefined),
    });
    const a = await send("task A");
    const queued = await reply({ text: "re: older", to: OLDER, timeout: 1 });
    expect([
      queued.outcome.status,
      (await jobs.load(queued.jobId))?.replyToId,
      (await jobs.load(queued.jobId))?.state.status,
      bot.sends(),
    ]).toEqual(["pending", OLDER, "queued", ["task A"]]);

    bot.finish("RESULT A");
    await wait(a.jobId);
    const waited = await wait(queued.jobId);
    expect([
      done(waited.outcome),
      bot.sends(),
      bot.sentBodies()[1]?.replyToId,
      (await jobs.load(queued.jobId))?.replyToId,
    ]).toEqual(["OK", ["task A", "re: older"], OLDER, OLDER]);
  });

  it("applies the project label once", async () => {
    const route = { agentId: AGENT, label: "Proj" };
    const { bot, reply } = setup(
      { autoReply: () => "OK" },
      { cwd: dir, projectRoutes: async () => new Map([[dir, route]]) },
    );
    await reply({ text: "plain", to: OLDER });
    await reply({ text: "[proj] already tagged", to: OLDER });
    expect(bot.sends()).toEqual(["[Proj] plain", "[proj] already tagged"]);
  });
});

describe("reply refusals", () => {
  async function refused(
    attempt: Promise<unknown>,
    bot: { sends(): unknown[] },
    sentBefore: unknown[],
  ) {
    const error = await attempt.catch((e: unknown) => e);
    expect([error instanceof GrokBotError, bot.sends()]).toEqual([
      true,
      sentBefore,
    ]);
    return error instanceof Error ? error.message : String(error);
  }

  it("refuses an unknown job and sends nothing", async () => {
    const { bot, reply } = setup();
    const message = await refused(
      reply({ job: "no-such-job", text: "hi" }),
      bot,
      [],
    );
    expect(message).toContain("no-such-job");
    expect(await jobs.list()).toEqual([]);
  });

  it("refuses an entry that is not in the bot's transcript, and leaves no job", async () => {
    const { bot, reply } = setup();
    const message = await refused(
      reply({ text: "hi", to: "entry-9999" }),
      bot,
      [],
    );
    expect(message).toContain("entry-9999");
    expect(await jobs.list()).toEqual([]);
  });

  it("refuses a job whose message is still queued", async () => {
    const { bot, send, reply } = setup();
    await send("task A");
    const b = await send("task B");
    const message = await refused(reply({ job: b.jobId, text: "hi" }), bot, [
      "task A",
    ]);
    expect(message).toContain(b.jobId);
    expect(await jobs.list()).toHaveLength(2);
  });

  it("refuses a job whose bot has posted nothing yet", async () => {
    const { bot, send, reply } = setup();
    const a = await send("task A");
    await refused(reply({ job: a.jobId, text: "hi" }), bot, ["task A"]);
  });

  it("refuses text with neither a job nor --to", async () => {
    const { bot, reply } = setup();
    await refused(reply({ text: "hi" }), bot, []);
  });
});
