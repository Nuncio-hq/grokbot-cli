import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import { type UsageLog, usageLog } from "./usage-log.js";
import { usageEnabled, withUsageLog } from "./usage-runner.js";

const PRIMARY = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const MAIN = "00000000-0000-4000-8000-000000000000";
const T0 = new Date(2026, 9, 16, 22, 5).getTime();

let dir: string;
let log: UsageLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-usage-runner-"));
  log = usageLog(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function wrap(result: () => unknown, enabled = true) {
  let clock = T0;
  const inner: CommandRunner = {
    run: async () => {
      clock += 12_000;
      return result() as never;
    },
  };
  return withUsageLog(inner, {
    surface: "cli",
    version: "0.1.2",
    client: () => "claude-desktop",
    enabled: async () => enabled,
    log,
    now: () => clock,
  });
}

describe("withUsageLog", () => {
  it("records the command, caller and outcome, never the message or the bot's identity", async () => {
    const runner = wrap(() => ({
      jobId: "job-1",
      agent: { agentId: PRIMARY, name: "Primary Test" },
      outcome: { status: "done", finalReply: "SECRET REPLY", replies: [] },
    }));
    await runner.run("ask", {
      text: "SECRET PLAN",
      agent: "Primary Test",
      timeout: 600,
      json: false,
    });
    const [event] = await log.read();
    expect(event).toEqual({
      v: 1,
      hour: "2026-10-16T22",
      command: "ask",
      surface: "cli",
      client: "claude-desktop",
      status: "done",
      duration: "<1m",
      flags: ["agent", "text", "timeout"],
      bot: "test",
      version: "0.1.2",
      os: expect.any(String),
    });
    const raw = await readFile(join(dir, "2026-10.jsonl"), "utf8");
    for (const secret of ["SECRET", "Primary Test", PRIMARY, "job-1"])
      expect(raw).not.toContain(secret);
  });

  it("records a queued send and the main bot", async () => {
    const runner = wrap(() => ({
      jobId: "j",
      agent: { agentId: MAIN, name: "Grok Bot" },
      sentMessageId: "m",
      queued: true,
    }));
    await runner.run("send", { text: "x", json: false });
    const [event] = await log.read();
    expect([event?.status, event?.bot]).toEqual(["queued", "main"]);
  });

  it("records a failure by its error code and rethrows the same error", async () => {
    const failure = new GrokBotError("timeout", "slow");
    const runner = wrap(() => {
      throw failure;
    });
    await expect(runner.run("agents", { json: false })).rejects.toBe(failure);
    const [event] = await log.read();
    expect([event?.status, event?.errorCode, event?.bot]).toEqual([
      "error",
      "timeout",
      undefined,
    ]);
  });

  it("writes nothing when turned off", async () => {
    await wrap(() => ({ agents: [] }), false).run("agents", { json: false });
    expect(await log.read()).toEqual([]);
  });

  it("never lets a broken log change the command's result", async () => {
    const broken: CommandRunner = withUsageLog(
      { run: async () => ({ agents: [] }) as never },
      {
        surface: "mcp",
        version: "0.1.2",
        client: () => "cursor",
        enabled: async () => true,
        log: {
          dir,
          append: async () => {
            throw new Error("disk full");
          },
          read: async () => [],
        },
      },
    );
    expect(await broken.run("agents", { json: false })).toEqual({
      agents: [],
    });
  });
});

describe("usageEnabled", () => {
  it.each([
    [{}, "on", true],
    [{}, "off", false],
    [{ GROKBOT_USAGE: "off" }, "on", false],
    [{ GROKBOT_USAGE: "0" }, "on", false],
    [{ GROKBOT_USAGE: "on" }, "off", true],
  ] as const)("env %j with setting %s is %s", async (env, setting, on) => {
    expect(await usageEnabled(env, async () => setting)).toBe(on);
  });
});
