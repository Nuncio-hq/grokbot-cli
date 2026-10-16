import { type BotMessageCount, localHour, type UsageEvent } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { runCli } from "./fixtures/run-cli.js";
import type { StatsDeps } from "./stats-command.js";

const NOW = new Date(2026, 9, 16, 22, 30).getTime();
const ev = (over: Partial<UsageEvent>): UsageEvent =>
  ({
    v: 1,
    hour: "2026-10-16T22",
    command: "ask",
    surface: "cli",
    client: "human",
    status: "done",
    duration: "<10s",
    flags: [],
    version: "0.1.2",
    os: "darwin",
    ...over,
  }) as UsageEvent;

function fakeStats(
  events: readonly UsageEvent[],
  bots: readonly BotMessageCount[] = [],
) {
  const asked: { since?: string | undefined; botsSince?: number } = {};
  const deps: StatsDeps = {
    dir: "/home/me/.grokbot/usage",
    readEvents: async (since) => {
      asked.since = since;
      return [...events];
    },
    logOn: async () => true,
    botCounts: async (sinceMs) => {
      asked.botsSince = sinceMs;
      return [...bots];
    },
    now: () => NOW,
  };
  return { deps, asked };
}

describe("grokbot stats", () => {
  it("summarises the last 30 days by caller, outcome and command", async () => {
    const { deps, asked } = fakeStats([
      ev({ client: "claude-desktop", bot: "test" }),
      ev({ client: "claude-desktop", command: "send", status: "queued" }),
      ev({ status: "error", errorCode: "timeout" }),
    ]);
    const run = await runCli(["stats"], { stats: deps });
    expect(run.code).toBe(0);
    // Local time: the 30 days may cross a daylight-saving change.
    expect(asked.since).toBe(localHour(NOW - 30 * 86_400_000));
    expect(run.stdout).toBe(
      [
        "grokbot usage, last 30 days: 3 runs",
        "",
        "Who:       claude-desktop 2 · human 1",
        "Where:     cli 3",
        "Outcomes:  done 1 · error 1 · queued 1",
        "Errors:    timeout 1",
        "Time:      <10s 3",
        "Bot kinds: test 1",
        "",
        "Commands:",
        "  ask          2  (1 failed)",
        "  send         1",
        "",
        "Usage log: on, local only, in /home/me/.grokbot/usage",
        "",
      ].join("\n"),
    );
  });

  it("adds each bot's grokbot and other message counts with --bots", async () => {
    const { deps, asked } = fakeStats(
      [],
      [{ bot: "Grok Bot", other: 12, viaGrokbot: 3 }],
    );
    const run = await runCli(["stats", "--bots", "--since", "7d"], {
      stats: deps,
    });
    expect(asked.botsSince).toBe(NOW - 7 * 86_400_000);
    expect(run.stdout).toContain(
      "Your messages per bot, last 7 days (other = Grok Bot app, or a tool with no grokbot job):\n  Grok Bot  grokbot   3   other  12\n",
    );
  });

  it("--json prints one document and --since all reads everything", async () => {
    const { deps, asked } = fakeStats([ev({})]);
    const run = await runCli(["stats", "--since=all", "--json"], {
      stats: deps,
    });
    const doc = JSON.parse(run.stdout);
    expect([asked.since, doc.since, doc.total, doc.logOn]).toEqual([
      undefined,
      null,
      1,
      true,
    ]);
  });

  it.each([
    [["stats", "--since", "week"], "--since must be like 7d, 30d or 90d"],
    [["stats", "--since"], "--since needs a value"],
    [["stats", "--everything"], 'unknown argument "--everything"'],
  ])("%j is a usage error", async (argv, message) => {
    const run = await runCli(argv, { stats: fakeStats([]).deps });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it("has help and is listed in general help", async () => {
    const help = await runCli(["stats", "--help"]);
    expect(help.stdout).toContain(
      "Usage: grokbot stats [--since <7d|30d|90d|all>] [--bots] [--json]",
    );
    expect((await runCli(["--help"])).stdout).toMatch(/\n {2}stats\s+Show how/);
  });
});
