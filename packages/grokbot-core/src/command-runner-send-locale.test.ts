import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { CommandRunnerOptions } from "./command-runner-contract.js";
import { GrokBotError, type ServerTransport } from "./contracts.js";
import {
  QUEUE_AGENT as AGENT,
  type QueueBotOptions,
  queueBot,
} from "./fixtures/queue-bot.js";
import { type JobStore, jobStore } from "./job-store.js";

let dir: string;
let jobs: JobStore;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "grokbot-send-locale-")));
  jobs = jobStore(join(dir, "jobs"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Seen {
  readonly method: string;
  /** The extra headers the call asked for; undefined when it asked for none. */
  readonly headers: Readonly<Record<string, string>> | undefined;
}

/** A runner over `inner` that records which extra headers each server call asked for. */
function runnerOver(inner: ServerTransport, options: CommandRunnerOptions) {
  const seen: Seen[] = [];
  const server: ServerTransport = {
    call(method, body, callOptions) {
      seen.push({ method, headers: callOptions?.headers });
      return inner.call(method, body, callOptions);
    },
    stream(method, body, callOptions) {
      seen.push({ method, headers: callOptions?.headers });
      return inner.stream(method, body, callOptions);
    },
  };
  const run = createCommandRunner({
    server,
    jobs,
    cwd: dir,
    projectRoutes: async () => new Map(),
    ...options,
  });
  const send = (text: string) =>
    run.run("send", { text, agent: AGENT, now: false, json: false });
  return { run, send, seen };
}

function setup(options: CommandRunnerOptions, bot?: QueueBotOptions) {
  const queue = queueBot(bot);
  return { bot: queue, ...runnerOver(queue.server, options) };
}

const sendHeaders = (seen: readonly Seen[]) =>
  seen
    .filter((c) => c.method === "SendGrokBotUserMessage")
    .map((c) => c.headers);

describe("the time zone header and language field of a send", () => {
  it("puts the time zone on SendGrokBotUserMessage and on no other call", async () => {
    const { run, send, seen } = setup(
      { env: { GROKBOT_TIMEZONE: "Europe/Berlin" } },
      { autoReply: () => "OK" },
    );
    const sent = await send("ping");
    await run.run("wait", { job: sent.jobId, timeout: 5, json: false });
    await run.run("team", { json: false });
    await run.run("tail", { limit: 3, agent: AGENT, json: false });

    expect(seen.map((c) => c.method)).toEqual(
      expect.arrayContaining([
        "ListGrokBotAgents",
        "ListGrokBotAgentStatuses",
        "ListGrokBotTranscriptEntries",
        "SendGrokBotUserMessage",
      ]),
    );
    expect(
      seen
        .filter((c) => c.headers !== undefined)
        .map((c) => [c.method, c.headers]),
    ).toEqual([
      ["SendGrokBotUserMessage", { "x-cursor-timezone": "Europe/Berlin" }],
    ]);
  });

  it("sends the Mac's own time zone and language when no env names a zone", async () => {
    const { bot, send, seen } = setup({
      env: {},
      system: { platform: "darwin", timeZone: "Asia/Tokyo", locale: "pt-BR" },
    });
    await send("ping");
    expect([
      sendHeaders(seen),
      bot.sentBodies().map((body) => body.language),
    ]).toEqual([[{ "x-cursor-timezone": "Asia/Tokyo" }], ["pt"]]);
  });

  it("sends no time zone and no language from another platform, which would replace the owner's zone", async () => {
    const { bot, send, seen } = setup({
      env: {},
      system: { platform: "linux", timeZone: "UTC", locale: "pt-BR" },
    });
    await send("ping");
    expect([
      sendHeaders(seen),
      bot.sentBodies().map((body) => "language" in body),
    ]).toEqual([[undefined], [false]]);
  });

  it("fails the send for an invalid GROKBOT_TIMEZONE before a job is saved or the bot is read", async () => {
    const { bot, send, seen } = setup({
      env: { GROKBOT_TIMEZONE: "Mars/Base" },
    });
    const error = await send("ping").catch((e: unknown) => e);
    expect([
      error instanceof GrokBotError,
      error instanceof Error && error.message.includes("GROKBOT_TIMEZONE"),
      seen.map((c) => c.method),
      bot.sends(),
      await jobs.list(),
    ]).toEqual([true, true, ["ListGrokBotAgents"], [], []]);
  });

  it("applies the zone of whoever sends a queued message, when the bot is free", async () => {
    const bot = queueBot({
      autoReply: (text) => (text === "task B" ? "OK" : undefined),
    });
    const berlin = runnerOver(bot.server, {
      env: { GROKBOT_TIMEZONE: "Europe/Berlin" },
    });
    const newYork = runnerOver(bot.server, {
      env: { GROKBOT_TIMEZONE: "America/New_York" },
    });

    await berlin.send("task A");
    const queued = await berlin.send("task B");
    expect(sendHeaders(berlin.seen)).toEqual([
      { "x-cursor-timezone": "Europe/Berlin" },
    ]);

    bot.finish("RESULT A");
    await newYork.run.run("wait", {
      job: queued.jobId,
      timeout: 5,
      json: false,
    });
    expect(sendHeaders(newYork.seen)).toEqual([
      { "x-cursor-timezone": "America/New_York" },
    ]);
  });
});
