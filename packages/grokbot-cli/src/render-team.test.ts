import { GrokBotError } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const BOT = `Primary Test (${PRIMARY.agentId.slice(0, 8)})`;
const PROPOSED = "2025-10-09T08:53:20.000Z";
const REVIEWED = "2025-10-09T09:53:20.000Z";

const MEMORY = {
  itemId: "item-memory",
  status: "pending" as const,
  proposedByUserId: "4521",
  reviewedByUserId: null,
  createdAt: PROPOSED,
  reviewedAt: null,
  change: {
    kind: "memory" as const,
    action: "write" as const,
    memoryType: "fact",
    text: "Standup is at 9:30",
  },
  method: "remember",
  summary: "Standup time",
};
const SKILL = {
  itemId: "item-skill",
  status: "approved" as const,
  proposedByUserId: "17",
  reviewedByUserId: "9",
  createdAt: PROPOSED,
  reviewedAt: REVIEWED,
  change: {
    kind: "skill" as const,
    action: "update" as const,
    name: "weekly-report",
    description: "Weekly report",
    content: "---\nname: weekly-report\n---\nWrite it.",
  },
  method: "propose_skill",
  summary: "Update the weekly report",
};
const MEMORY_BLOCK =
  "item-memory  pending\n" +
  `  Proposed by user 4521 on ${PROPOSED}\n` +
  '  Change: Add a memory (fact): "Standup is at 9:30"\n' +
  "  Summary: Standup time\n" +
  "  Method: remember\n";
const SKILL_BLOCK =
  "item-skill  approved\n" +
  `  Proposed by user 17 on ${PROPOSED}\n` +
  `  Reviewed by user 9 on ${REVIEWED}\n` +
  '  Change: Update the skill weekly-report: "Weekly report"\n' +
  "  Content: --- name: weekly-report --- Write it.\n" +
  "  Summary: Update the weekly report\n" +
  "  Method: propose_skill\n";

describe("review on the CLI", () => {
  it("defaults to pending items, 20 at most, and takes --status and -n", async () => {
    const plain = await runCli(["review"], {
      outputs: {
        review: { agent: PRIMARY, status: "pending", limit: 20, items: [] },
      },
    });
    const all = await runCli(
      ["review", "--agent", "Primary Test", "--status", "all", "-n", "5"],
      {
        outputs: {
          review: { agent: PRIMARY, status: "all", limit: 5, items: [] },
        },
      },
    );
    expect([plain.calls[0]?.input, all.calls[0]?.input]).toEqual([
      { status: "pending", limit: 20, json: false },
      { agent: "Primary Test", status: "all", limit: 5, json: false },
    ]);
    expect([plain.stdout, all.stdout]).toEqual([
      "Primary Test has no pending review items.\n",
      "Primary Test has no review items.\n",
    ]);
  });

  it("prints one block per item: id, status, who and when, the change in words, the summary", async () => {
    const one = await runCli(["review"], {
      outputs: {
        review: {
          agent: PRIMARY,
          status: "pending",
          limit: 20,
          items: [MEMORY],
        },
      },
    });
    const both = await runCli(["review", "--status", "all"], {
      outputs: {
        review: {
          agent: PRIMARY,
          status: "all",
          limit: 20,
          items: [MEMORY, SKILL],
        },
      },
    });
    expect([one.stdout, both.stdout]).toEqual([
      `1 pending review item for ${BOT}:\n\n${MEMORY_BLOCK}`,
      `2 review items for ${BOT}:\n\n${MEMORY_BLOCK}\n${SKILL_BLOCK}`,
    ]);
  });

  it("names a missing proposer or time, and says when the limit may have cut the list", async () => {
    const run = await runCli(["review", "-n", "1"], {
      outputs: {
        review: {
          agent: PRIMARY,
          status: "pending",
          limit: 1,
          items: [
            {
              ...MEMORY,
              status: "unknown",
              proposedByUserId: null,
              createdAt: null,
              change: { kind: "unknown" },
              method: "",
              summary: "",
            },
          ],
        },
      },
    });
    expect(run.stdout).toBe(
      `1 pending review item for ${BOT}:\n\n` +
        "item-memory  unknown\n" +
        "  Proposed by someone on an unknown time\n" +
        "  Change: A change this grokbot does not recognise (see --json).\n" +
        "\nThe list stops at 1 item; raise --limit to see more.\n",
    );
  });

  it("cuts long proposed text in the words and keeps all of it under --json", async () => {
    const text = "a ".repeat(300);
    const long = {
      ...MEMORY,
      change: { ...MEMORY.change, memoryType: "", text },
    };
    const output = {
      agent: PRIMARY,
      status: "pending" as const,
      limit: 20,
      items: [long],
    };
    const human = await runCli(["review"], { outputs: { review: output } });
    const json = await runCli(["review", "--json"], {
      outputs: { review: output },
    });
    expect(human.stdout).toContain(
      `  Change: Add a memory: "${"a ".repeat(99)}a…"\n`,
    );
    expect(
      Math.max(...human.stdout.split("\n").map((l) => l.length)),
    ).toBeLessThan(300);
    expect(JSON.parse(json.stdout).items[0].change.text).toBe(text);
  });
});

describe("review-resolve on the CLI", () => {
  it("parses the item, --decision and --yes, and prints the updated item", async () => {
    const approved = { ...MEMORY, status: "approved" as const };
    const run = await runCli(
      ["review-resolve", "item-memory", "--decision", "approve", "--yes"],
      {
        outputs: {
          "review-resolve": {
            agent: PRIMARY,
            decision: "approve",
            itemId: "item-memory",
            item: approved,
          },
        },
      },
    );
    expect(run.calls[0]?.input).toEqual({
      item: "item-memory",
      decision: "approve",
      yes: true,
      json: false,
    });
    expect(run.stdout).toBe(
      "Approved review item item-memory of Primary Test.\n\n" +
        MEMORY_BLOCK.replace("pending", "approved"),
    );
  });

  it("says only what was decided when the server sent no item back", async () => {
    const run = await runCli(
      ["review-resolve", "item-memory", "--decision", "reject", "--yes"],
      {
        outputs: {
          "review-resolve": {
            agent: PRIMARY,
            decision: "reject",
            itemId: "item-memory",
            item: null,
          },
        },
      },
    );
    expect(run.stdout).toBe(
      "Rejected review item item-memory of Primary Test.\n",
    );
  });

  it("without --yes passes yes: false, so the runner refuses with exit 1", async () => {
    const run = await runCli(
      ["review-resolve", "item-memory", "--decision", "approve"],
      {
        error: new GrokBotError(
          "safety",
          "review-resolve changes or deletes live data. Re-run with --yes.",
        ),
      },
    );
    expect([run.calls[0]?.input, run.stderr, run.code]).toEqual([
      { item: "item-memory", decision: "approve", yes: false, json: false },
      "grokbot: review-resolve changes or deletes live data. Re-run with --yes.\n",
      1,
    ]);
  });

  it("needs the item and a decision", async () => {
    const noDecision = await runCli(["review-resolve", "item-memory"]);
    const noItem = await runCli(["review-resolve", "--decision", "reject"]);
    expect(
      [noDecision, noItem].map((r) => [r.code, r.stderr.split("\n")[0]]),
    ).toEqual([
      [2, "grokbot: review-resolve: missing required flag --decision"],
      [2, "grokbot: review-resolve: missing required argument <item>"],
    ]);
  });
});

describe("analytics on the CLI", () => {
  const FULL = {
    agent: PRIMARY,
    weeklyActiveUsers: 4,
    totalMinutesSaved: 123.46,
    minutesSavedBeforeWindow: 20,
    minutesSavedMeasured: true,
    days: [
      {
        day: "2026-10-19",
        activeUsers: 2,
        trailingSevenDayActiveUsers: 4,
        userTurns: 12,
        minutesSaved: 30.5,
      },
      {
        day: "2026-10-20",
        activeUsers: 1,
        trailingSevenDayActiveUsers: 4,
        userTurns: 3,
        minutesSaved: 0.5,
      },
    ],
    topUsers: [
      {
        userId: 77,
        displayName: "Ana Silva",
        userTurns: 40,
        minutesSaved: 90.25,
        isExternal: false,
      },
      {
        userId: 78,
        displayName: "",
        userTurns: 2,
        minutesSaved: 1,
        isExternal: true,
      },
    ],
  };

  it("prints the headline numbers, a table of days and a table of top users", async () => {
    const run = await runCli(["analytics", "--agent", "Primary Test"], {
      outputs: { analytics: FULL },
    });
    expect(run.calls[0]?.input).toEqual({ agent: "Primary Test", json: false });
    expect(run.stdout).toBe(
      `Usage of ${BOT}:\n` +
        "Weekly active users: 4\n" +
        "Minutes saved: 123.5\n" +
        "Minutes saved before 2026-10-19: 20\n" +
        "\n" +
        "DAY         ACTIVE  7-DAY ACTIVE  MESSAGES  MINUTES SAVED\n" +
        "2026-10-19  2       4             12        30.5\n" +
        "2026-10-20  1       4             3         0.5\n" +
        "\n" +
        "Top users:\n" +
        "USER                MESSAGES  MINUTES SAVED\n" +
        "Ana Silva           40        90.3\n" +
        "user 78 (external)  2         1\n",
    );
  });

  it("shows no total while the server has not measured the minutes, and says when there is no usage", async () => {
    const unmeasured = await runCli(["analytics"], {
      outputs: {
        analytics: {
          ...FULL,
          minutesSavedMeasured: false,
          days: [],
          topUsers: [],
        },
      },
    });
    const idle = await runCli(["analytics"], {
      outputs: {
        analytics: {
          agent: PRIMARY,
          weeklyActiveUsers: 0,
          totalMinutesSaved: 0,
          minutesSavedBeforeWindow: 0,
          minutesSavedMeasured: false,
          days: [],
          topUsers: [],
        },
      },
    });
    expect([unmeasured.stdout, idle.stdout]).toEqual([
      `Usage of ${BOT}:\nWeekly active users: 4\nMinutes saved: not measured\n`,
      `Usage of ${BOT}:\nWeekly active users: 0\nMinutes saved: not measured\nNo usage recorded yet.\n`,
    ]);
  });

  it("prints the full numbers under --json", async () => {
    const run = await runCli(["analytics", "--json"], {
      outputs: { analytics: FULL },
    });
    expect(JSON.parse(run.stdout)).toMatchObject({
      totalMinutesSaved: 123.46,
      days: FULL.days,
      topUsers: FULL.topUsers,
    });
  });
});

describe("suggestions on the CLI", () => {
  const SUGGESTIONS = [
    {
      id: "sg-1",
      icon: "sun",
      title: "Morning brief",
      detail: "Weather and calendar",
      prompt: "Give me my morning brief",
    },
    { id: "sg-2", icon: "mail", title: "", detail: "", prompt: "" },
  ];

  it("lists each suggestion, or says the bot has none", async () => {
    const some = await runCli(["suggestions"], {
      outputs: {
        suggestions: { agent: PRIMARY, suggestions: SUGGESTIONS },
      },
    });
    const none = await runCli(["suggestions", "--agent", "Primary Test"], {
      outputs: { suggestions: { agent: PRIMARY, suggestions: [] } },
    });
    expect([some.stdout, none.stdout, none.calls[0]?.input]).toEqual([
      `Suggestions for ${BOT}:\n` +
        "ID    TITLE          DETAIL                PROMPT\n" +
        "sg-1  Morning brief  Weather and calendar  Give me my morning brief\n" +
        "sg-2  -              -                     -\n" +
        "Close some with: grokbot suggestions-dismiss --suggestion <id>\n",
      "Primary Test has no suggestions.\n",
      { agent: "Primary Test", json: false },
    ]);
  });

  it("suggestions-dismiss takes repeated or comma-separated --suggestion and --reason", async () => {
    const out = {
      agent: PRIMARY,
      reason: "hidden" as const,
      dismissed: SUGGESTIONS,
    };
    const plain = await runCli(
      ["suggestions-dismiss", "--suggestion", "sg-1", "--suggestion", "sg-2"],
      { outputs: { "suggestions-dismiss": out } },
    );
    const acted = await runCli(
      ["suggestions-dismiss", "--suggestion", "sg-1,sg-2", "--reason", "acted"],
      { outputs: { "suggestions-dismiss": { ...out, reason: "acted" } } },
    );
    expect([plain.calls[0]?.input, acted.calls[0]?.input]).toEqual([
      { suggestion: ["sg-1", "sg-2"], reason: "hidden", json: false },
      { suggestion: ["sg-1", "sg-2"], reason: "acted", json: false },
    ]);
    expect([plain.stdout, acted.stdout]).toEqual([
      "Closed 2 suggestions of Primary Test (hidden): Morning brief, sg-2.\n",
      "Closed 2 suggestions of Primary Test (acted): Morning brief, sg-2.\n",
    ]);
  });

  it("needs a suggestion id", async () => {
    const run = await runCli(["suggestions-dismiss"]);
    expect([run.code, run.stderr.split("\n")[0]]).toEqual([
      2,
      "grokbot: suggestions-dismiss: missing required flag --suggestion",
    ]);
  });
});
