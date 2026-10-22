import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { CommandRunnerOptions } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  QUEUE_AGENT as AGENT,
  type QueueBotOptions,
  queueBot,
} from "./fixtures/queue-bot.js";
import { blobRow, sendMessageRow } from "./fixtures/wire-entries.js";
import { type JobRecord, type JobStore, jobStore } from "./job-store.js";

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
    run.run("send", { text, agent: AGENT, now: false, json: false });
  const wait = (job: string, timeout = 5) =>
    run.run("wait", { job, timeout, json: false });
  const reply = (input: {
    job?: string;
    text: string;
    to?: string;
    quote?: string;
    timeout?: number;
    now?: boolean;
  }) =>
    run.run("reply", {
      timeout: 5,
      now: false,
      json: false,
      agent: AGENT,
      ...input,
    });
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

  it("tags the reply once, with the project and the runtime", async () => {
    const route = { agentId: AGENT, label: "Proj" };
    const { bot, reply } = setup(
      { autoReply: () => "OK" },
      {
        cwd: dir,
        caller: "omp",
        projectRoutes: async () => new Map([[dir, route]]),
      },
    );
    await reply({ text: "plain", to: OLDER });
    await reply({
      text: "[project: proj · runtime: omp] already tagged",
      to: OLDER,
    });
    expect(
      bot
        .sends()
        .map((text) => String(text).replace(/Job: [0-9a-f]{8}/, "Job: <job>")),
    ).toEqual([
      "[Project: Proj · Runtime: omp · Job: <job>] plain",
      "[Project: Proj · Runtime: omp · Job: <job>] already tagged",
    ]);
  });
});

describe("reply on a job the bot has not answered yet", () => {
  it("quotes the job's own message, queued behind the bot's work unless --now", async () => {
    const { bot, send, reply } = setup();
    const a = await send("task A");
    const echoOfA = "entry-140";
    const queued = await reply({ job: a.jobId, text: "also B", timeout: 1 });
    const now = await reply({
      job: a.jobId,
      text: "also C",
      timeout: 1,
      now: true,
    });
    expect([
      queued.replyToId,
      (await jobs.load(queued.jobId))?.state.status,
      now.replyToId,
      (await jobs.load(now.jobId))?.botBusyAtSend,
      bot.sentBodies().map((b) => [b.text, b.replyToId]),
    ]).toEqual([
      echoOfA,
      "queued",
      echoOfA,
      true,
      [
        ["task A", undefined],
        ["also C", echoOfA],
      ],
    ]);
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

  it("refuses text with neither a job nor --to", async () => {
    const { bot, reply } = setup();
    await refused(reply({ text: "hi" }), bot, []);
  });

  it("refuses a quote that is not in the answered message, whatever its spacing, and sends nothing", async () => {
    const { bot, send, wait, reply } = setup();
    const a = await send("task A");
    bot.finish("Shall I proceed?");
    await wait(a.jobId);
    const message = await refused(
      reply({ job: a.jobId, text: "yes", quote: "Shall I stop?" }),
      bot,
      ["task A"],
    );
    expect(message).toContain("entry-141");
    expect(message).toContain("--quote");
    expect((await jobs.list()).map((job) => job.jobId)).toEqual([a.jobId]);
  });

  it("refuses a quote that is not in the entry --to names", async () => {
    const { bot, reply } = setup();
    const message = await refused(
      reply({ text: "hi", to: OLDER, quote: "newer" }),
      bot,
      [],
    );
    expect(message).toContain(OLDER);
    expect(await jobs.list()).toEqual([]);
  });

  it.each(["", "  ", "\n\t "])(
    "refuses an empty quote (%j) and sends nothing",
    async (quote) => {
      const { bot, reply } = setup();
      const message = await refused(
        reply({ text: "hi", to: OLDER, quote }),
        bot,
        [],
      );
      expect(message).toContain("empty");
      expect(await jobs.list()).toEqual([]);
    },
  );
});

describe("reply --quote", () => {
  it("sends the quote with replyToId in one call and keeps both on the job; a longer message may be quoted in part, with its spacing changed", async () => {
    const { bot, send, wait, reply } = setup({
      autoReply: (text) => (text === "A" ? "OK" : undefined),
    });
    const a = await send("task A");
    bot.finish("Pick one:  A\nor B, then say go");
    await wait(a.jobId);

    const out = await reply({
      job: a.jobId,
      text: "A",
      quote: "Pick one: A or B",
    });
    const sent = bot.sentBodies()[1];
    const saved = await jobs.load(out.jobId);
    expect([
      done(out.outcome),
      sent?.replyToId,
      sent?.replyQuote,
      saved?.replyToId,
      saved?.replyQuote,
    ]).toEqual([
      "OK",
      "entry-141",
      "Pick one: A or B",
      "entry-141",
      "Pick one: A or B",
    ]);
  });

  it("quotes part of the entry --to names", async () => {
    const { bot, reply } = setup({ autoReply: () => "OK" });
    await reply({ text: "re: older", to: OLDER, quote: "old" });
    expect(bot.sentBodies().map((b) => [b.replyToId, b.replyQuote])).toEqual([
      [OLDER, "old"],
    ]);
  });

  it("sends no replyQuote on a plain send or on a reply without --quote", async () => {
    const { bot, send, reply } = setup({ autoReply: () => "OK" });
    await send("task A");
    await reply({ text: "re: older", to: OLDER });
    expect(bot.sentBodies().map((b) => "replyQuote" in b)).toEqual([
      false,
      false,
    ]);
  });

  it("never sends a quote without the entry it quotes", async () => {
    const { bot, wait } = setup();
    const orphan: JobRecord = {
      jobId: "orphan-job",
      agentId: AGENT,
      agentName: "Primary Test",
      text: "orphan",
      queuedAtMs: Date.now(),
      replyQuote: "stray words",
      sentMessageId: "m-orphan",
      sentAtMs: Date.now(),
      baselineUpdatedSeq: "0",
      generation: "0",
      state: { status: "queued" },
    };
    await jobs.save(orphan);
    await wait(orphan.jobId, 1);
    expect(
      bot
        .sentBodies()
        .map((b) => [b.text, "replyToId" in b, "replyQuote" in b]),
    ).toEqual([["orphan", false, false]]);
  });

  it("keeps the quote on a reply queued behind a busy bot, and sends it with replyToId once the bot is free", async () => {
    const { bot, send, wait, reply } = setup({
      autoReply: (text) => (text === "re: older" ? "OK" : undefined),
    });
    const a = await send("task A");
    const queued = await reply({
      text: "re: older",
      to: OLDER,
      quote: "old",
      timeout: 1,
    });
    const saved = await jobs.load(queued.jobId);
    expect([
      saved?.state.status,
      saved?.replyToId,
      saved?.replyQuote,
      bot.sentBodies().map((b) => b.text),
    ]).toEqual(["queued", OLDER, "old", ["task A"]]);

    bot.finish("RESULT A");
    await wait(a.jobId);
    const waited = await wait(queued.jobId);
    const sent = bot.sentBodies()[1];
    expect([
      done(waited.outcome),
      sent?.text,
      sent?.replyToId,
      sent?.replyQuote,
      (await jobs.load(queued.jobId))?.replyQuote,
    ]).toEqual(["OK", "re: older", OLDER, "old", "old"]);
  });
});

describe("reply --quote to an entry with no quotable text", () => {
  const replyTo = (row: unknown) => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotAgents: [
          {
            agents: [
              {
                id: "12928587",
                agentId: AGENT,
                name: "Primary Test",
                kind: "GROK_BOT_AGENT_KIND_AGENT",
              },
            ],
          },
        ],
        ListGrokBotTranscriptEntries: [{ entries: [row] }],
        ListGrokBotAgentStatuses: [{ statuses: [{ agentId: AGENT }] }],
        SendGrokBotUserMessage: [
          { dispatched: true, delivery: "GROK_BOT_DELIVERY_ACCEPTED_TEMPORAL" },
        ],
      },
    });
    const run = createCommandRunner({
      server,
      jobs,
      cwd: dir,
      projectRoutes: async () => new Map(),
    });
    const result = run.run("reply", {
      text: "re",
      to: "entry-139",
      quote: "words the entry holds",
      timeout: 1,
      now: false,
      json: false,
      agent: AGENT,
    });
    const sent = () =>
      log.find((c) => c.method === "SendGrokBotUserMessage")?.body;
    return { result, sent };
  };

  it("sends the quote as given to a reply stored as a blob, whose text cannot be read here", async () => {
    const { result, sent } = replyTo(blobRow(139, "send-message", "blob-139"));
    const out = await result;
    expect([out.replyToId, sent()?.replyToId, sent()?.replyQuote]).toEqual([
      "entry-139",
      "entry-139",
      "words the entry holds",
    ]);
  });

  it("refuses a quote of a card, which has no words to quote, and sends nothing", async () => {
    const { result, sent } = replyTo(
      sendMessageRow(139, { type: "widget", question: "Pick one" }),
    );
    await expect(result).rejects.toThrow(/--quote/);
    expect(sent()).toBeUndefined();
  });
});
