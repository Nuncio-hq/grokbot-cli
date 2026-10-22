import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  bodyOf,
  MAIN,
  methods,
  PROBE,
  type Recorded,
  type Script,
  STAFF,
  wireBot,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";
import { createServerTransport } from "./server-transport.js";
import { clipText, describeReviewChange } from "./workforce-team-review.js";

type Command =
  | "review"
  | "review-resolve"
  | "analytics"
  | "suggestions"
  | "suggestions-dismiss";

const SUGGESTIONS = [
  {
    id: "sg-1",
    icon: "sun",
    title: "Morning brief",
    detail: "Weather and calendar",
    prompt: "Give me my morning brief",
  },
  {
    id: "sg-2",
    icon: "mail",
    title: "Inbox triage",
    prompt: "Triage my inbox",
  },
];
/** The probe bot stands for a Team Bot; Staff Test is on the user's protected list. */
const ROSTER = [
  {
    agents: [
      wireBot(MAIN, "Grok Bot"),
      wireBot(STAFF, "Staff Test", { suggestions: SUGGESTIONS }),
      wireBot(PROBE, "Team Probe", { suggestions: SUGGESTIONS }),
    ],
  },
];
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;

/** Runs one command on Team Probe; the result or the error as [code, message], and the call log. */
async function run(command: Command, fields: JsonObject, server: Script = {}) {
  const { runner, log } = workforceRunner({
    ListGrokBotAgents: [ROSTER[0]],
    ...server,
  });
  const result = await runner
    .run(
      command as "review",
      {
        agent: "Team Probe",
        json: false,
        ...fields,
      } as never,
    )
    .catch(failure);
  return { result, log, calls: methods(log).map((m) => m.slice(7)) };
}

const callsTo = (log: readonly Recorded[], method: string) =>
  log.filter((c) => c.method === method);

/** The error the real transport makes of a refusal, so the wording tests see its true format. */
async function refused(method: string, status: number, body: string) {
  const transport = createServerTransport({
    getToken: async () => "synthetic-token",
    fetch: async () => new Response(body, { status }),
  });
  return transport.call(method, {}, { confirmed: true }).then(
    () => new Error("the call was not refused"),
    (error: unknown) => error,
  );
}
const refusalBody = (code: string, message?: string, detail?: string) =>
  JSON.stringify({
    code,
    ...(message !== undefined && { message }),
    ...(detail !== undefined && {
      details: [
        {
          type: "aiserver.v1.ErrorDetails",
          debug: { error: "ERROR_NOT_FOUND", details: { title: "x", detail } },
        },
      ],
    }),
  });
const throwing = (error: unknown) => (): never => {
  throw error;
};

const STATUS = (name: string) => `GROK_BOT_TEAM_REVIEW_ITEM_STATUS_${name}`;
const MEMORY_ITEM = {
  itemId: "item-memory",
  status: STATUS("PENDING"),
  proposedByUserId: "4521",
  createdAtMs: "1760000000000",
  change: {
    memory: {
      action: "GROK_BOT_TEAM_REVIEW_MEMORY_ACTION_WRITE",
      text: "Standup is at 9:30",
      memoryType: "fact",
    },
    method: "remember",
    summary: "Standup time",
  },
};
const SKILL_ITEM = {
  itemId: "item-skill",
  status: STATUS("APPROVED"),
  proposedByUserId: "17",
  reviewedByUserId: "9",
  createdAtMs: "1760000000000",
  reviewedAtMs: "1760003600000",
  change: {
    skill: {
      action: "GROK_BOT_TEAM_REVIEW_SKILL_ACTION_UPDATE",
      name: "weekly-report",
      description: "Weekly report",
      content: "---\nname: weekly-report\n---\nWrite it.",
    },
    method: "propose_skill",
    summary: "Update the weekly report",
  },
};
const FOLDER_ITEM = {
  itemId: "item-folder",
  status: STATUS("REJECTED"),
  proposedByUserId: "17",
  reviewedByUserId: "9",
  createdAtMs: "1760000000000",
  reviewedAtMs: "1760003600000",
  change: {
    folderMemory: {
      action: "GROK_BOT_TEAM_REVIEW_MEMORY_ACTION_FORGET",
      memoryType: "note",
      text: "old plan",
      metaJson: '{"source":"chat"}',
      path: "projects/alpha.md",
    },
    method: "forget_folder",
    summary: "Drop the old plan",
  },
};

describe("review", () => {
  const LIST = "ListGrokBotTeamReviewItems";

  it("asks for the 20 newest pending items by default and reads each change in full", async () => {
    const { result, log, calls } = await run(
      "review",
      { status: "pending", limit: 20 },
      { [LIST]: [{ items: [MEMORY_ITEM, SKILL_ITEM, FOLDER_ITEM] }] },
    );
    expect(calls).toEqual(["ListGrokBotAgents", LIST]);
    expect(bodyOf(log, LIST)).toEqual({
      agentId: PROBE,
      statuses: [STATUS("PENDING")],
      limit: 20,
    });
    expect(result).toMatchObject({
      agent: { agentId: PROBE, name: "Team Probe" },
      status: "pending",
      limit: 20,
      items: [
        {
          itemId: "item-memory",
          status: "pending",
          proposedByUserId: "4521",
          reviewedByUserId: null,
          createdAt: "2025-10-09T08:53:20.000Z",
          reviewedAt: null,
          change: {
            kind: "memory",
            action: "write",
            memoryType: "fact",
            text: "Standup is at 9:30",
          },
          method: "remember",
          summary: "Standup time",
        },
        {
          itemId: "item-skill",
          status: "approved",
          proposedByUserId: "17",
          reviewedByUserId: "9",
          createdAt: "2025-10-09T08:53:20.000Z",
          reviewedAt: "2025-10-09T09:53:20.000Z",
          change: {
            kind: "skill",
            action: "update",
            name: "weekly-report",
            description: "Weekly report",
            content: "---\nname: weekly-report\n---\nWrite it.",
          },
        },
        {
          itemId: "item-folder",
          status: "rejected",
          change: {
            kind: "folder-memory",
            action: "forget",
            memoryType: "note",
            path: "projects/alpha.md",
            text: "old plan",
            metaJson: '{"source":"chat"}',
          },
        },
      ],
    });
  });

  it.each<[string, string[]]>([
    ["approved", [STATUS("APPROVED")]],
    ["rejected", [STATUS("REJECTED")]],
    [" All ", [STATUS("PENDING"), STATUS("APPROVED"), STATUS("REJECTED")]],
  ])("--status %j asks for %j and passes --limit on", async (status, wire) => {
    const { result, log } = await run(
      "review",
      { status, limit: 5 },
      { [LIST]: [{}] },
    );
    expect(bodyOf(log, LIST)).toEqual({
      agentId: PROBE,
      statuses: wire,
      limit: 5,
    });
    expect(result).toMatchObject({
      status: status.trim().toLowerCase(),
      limit: 5,
      items: [],
    });
  });

  it("keeps a bare item and one with unknown values, saying what it does not know", async () => {
    const { result } = await run(
      "review",
      { status: "all", limit: 20 },
      {
        [LIST]: [
          {
            items: [
              { itemId: "bare" },
              {
                itemId: "odd",
                status: "GROK_BOT_TEAM_REVIEW_ITEM_STATUS_ARCHIVED",
                proposedByUserId: 0,
                createdAtMs: 1760000000000,
                change: {
                  skill: { action: "GROK_BOT_TEAM_REVIEW_SKILL_ACTION_CLONE" },
                  extra: true,
                },
              },
              {
                itemId: "toString",
                change: { memory: { action: "toString" } },
              },
            ],
          },
        ],
      },
    );
    const unknown = {
      status: "unknown",
      reviewedByUserId: null,
      reviewedAt: null,
      change: { kind: "unknown" },
      method: "",
      summary: "",
    };
    expect(result).toMatchObject({
      items: [
        { ...unknown, itemId: "bare", proposedByUserId: null, createdAt: null },
        {
          ...unknown,
          itemId: "odd",
          proposedByUserId: null,
          createdAt: "2025-10-09T08:53:20.000Z",
        },
        { ...unknown, itemId: "toString" },
      ],
    });
  });

  it("lists nothing for an empty reply", async () => {
    for (const reply of [{}, { items: [] }]) {
      const { result } = await run(
        "review",
        { status: "pending", limit: 20 },
        { [LIST]: [reply] },
      );
      expect(result).toMatchObject({ items: [] });
    }
  });

  it.each<[unknown, string]>([
    [[], "the reply is not an object"],
    [{ items: "none" }, "items is not a list"],
    [{ items: [7] }, "items[0] is not an object"],
    [{ items: [{ status: STATUS("PENDING") }] }, "items[0] has no itemId"],
    [
      { items: [{ itemId: "a", createdAtMs: "yesterday" }] },
      "createdAtMs is not an integer id",
    ],
    [
      { items: [{ itemId: "a", createdAtMs: "99999999999999999999" }] },
      "createdAtMs is not a time",
    ],
  ])("fails with a protocol error on %j", async (reply, problem) => {
    const { result } = await run(
      "review",
      { status: "pending", limit: 20 },
      { [LIST]: [reply] },
    );
    expect(result).toEqual(["protocol", `${LIST}: ${problem}`]);
  });

  it("refuses an unknown --status before any call", async () => {
    const { result, calls } = await run("review", {
      status: "done",
      limit: 20,
    });
    expect([result, calls]).toEqual([
      [
        "safety",
        '--status must be one of pending, approved, rejected, all, not "done".',
      ],
      [],
    ]);
  });

  it("passes the server's 403 for a personal bot through in plain words", async () => {
    const error = await refused(
      LIST,
      403,
      refusalBody(
        "permission_denied",
        "Only the owner or a manager of a Team Bot can review its changes.",
      ),
    );
    const { result } = await run(
      "review",
      { status: "pending", limit: 20 },
      { [LIST]: throwing(error) },
    );
    expect(result).toEqual([
      "http",
      "ListGrokBotTeamReviewItems for Team Probe was refused with HTTP 403: Only the owner or a manager of a Team Bot can review its changes. A personal bot has no review queue.",
    ]);
  });

  it("leaves a stale-login 403 with its login advice", async () => {
    const error = await refused(LIST, 403, refusalBody("unauthenticated"));
    const { result } = await run(
      "review",
      { status: "pending", limit: 20 },
      { [LIST]: throwing(error) },
    );
    expect(result).toEqual([
      "auth",
      `${LIST} was rejected with HTTP 403: {"code":"unauthenticated"}. If the login is stale, run grokbot login or open the Grok Bot app once to refresh it.`,
    ]);
  });
});

describe("review-resolve", () => {
  const RESOLVE = "ResolveGrokBotTeamReviewItem";
  const decide = (fields: JsonObject, server: Script = {}) =>
    run(
      "review-resolve",
      { item: "item-memory", decision: "approve", yes: true, ...fields },
      { [RESOLVE]: [{}], ...server },
    );

  it("refuses without --yes, before any call", async () => {
    const { result, calls } = await decide({ yes: false });
    expect([result, calls]).toEqual([
      [
        "safety",
        "review-resolve changes or deletes live data. Re-run with --yes.",
      ],
      [],
    ]);
  });

  it.each([
    ["approve", "GROK_BOT_TEAM_REVIEW_DECISION_APPROVE"],
    [" Reject ", "GROK_BOT_TEAM_REVIEW_DECISION_REJECT"],
  ])(
    "--decision %j sends %s, confirmed, and prints the updated item",
    async (decision, wire) => {
      const { result, log } = await decide(
        { decision },
        {
          [RESOLVE]: [
            {
              item: {
                ...MEMORY_ITEM,
                status: STATUS(
                  wire.endsWith("APPROVE") ? "APPROVED" : "REJECTED",
                ),
                reviewedByUserId: "9",
                reviewedAtMs: "1760003600000",
              },
            },
          ],
        },
      );
      expect(callsTo(log, RESOLVE)).toEqual([
        {
          via: "server",
          method: RESOLVE,
          body: { agentId: PROBE, itemId: "item-memory", decision: wire },
          confirmed: true,
        },
      ]);
      expect(result).toMatchObject({
        agent: { agentId: PROBE },
        decision: decision.trim().toLowerCase(),
        itemId: "item-memory",
        item: {
          itemId: "item-memory",
          status: wire.endsWith("APPROVE") ? "approved" : "rejected",
          reviewedByUserId: "9",
          reviewedAt: "2025-10-09T09:53:20.000Z",
          change: { kind: "memory", text: "Standup is at 9:30" },
        },
      });
    },
  );

  it("succeeds with no item when the reply carries none, and keeps the id it was given", async () => {
    const empty = await decide({ item: " item-9 " });
    const thin = await decide(
      { item: "item-9" },
      { [RESOLVE]: [{ item: { status: STATUS("APPROVED") } }] },
    );
    expect(empty.result).toMatchObject({ itemId: "item-9", item: null });
    expect(thin.result).toMatchObject({
      itemId: "item-9",
      item: { itemId: "item-9", status: "approved" },
    });
  });

  it("refuses an unknown --decision before any call", async () => {
    const { result, calls } = await decide({ decision: "maybe" });
    expect([result, calls]).toEqual([
      ["safety", '--decision must be one of approve, reject, not "maybe".'],
      [],
    ]);
  });

  it("refuses a protected bot unless --force-protected is its full agentId", async () => {
    const protectedBot = (force?: string) =>
      decide({
        agent: "Staff Test",
        ...(force !== undefined && { "force-protected": force }),
      });
    const refusedRun = await protectedBot();
    expect([refusedRun.result, refusedRun.calls]).toEqual([
      [
        "safety",
        `Staff Test (${STAFF.slice(0, 8)}) is protected, so review-resolve refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
      ],
      ["ListGrokBotAgents"],
    ]);
    const allowed = await protectedBot(STAFF);
    expect(allowed.calls).toEqual(["ListGrokBotAgents", RESOLVE]);
  });

  it("passes the server's 404 through naming the bot, with no hint of its own", async () => {
    const error = await refused(
      RESOLVE,
      404,
      refusalBody("not_found", "Review item not found"),
    );
    const { result } = await decide({}, { [RESOLVE]: throwing(error) });
    expect(result).toEqual([
      "not-found",
      "ResolveGrokBotTeamReviewItem for Team Probe was refused with HTTP 404: Review item not found.",
    ]);
  });
});

describe("analytics", () => {
  const ANALYTICS = "GetGrokBotAgentAnalytics";
  const FULL = {
    weeklyActiveUsers: 4,
    totalMinutesSaved: 123.5,
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
        displayName: "Guest",
        userTurns: 2,
        minutesSaved: 1,
        isExternal: true,
      },
    ],
  };

  it("sends the agent id and returns the numbers as they came", async () => {
    const { result, log, calls } = await run(
      "analytics",
      {},
      {
        [ANALYTICS]: [FULL],
      },
    );
    expect(calls).toEqual(["ListGrokBotAgents", ANALYTICS]);
    expect(bodyOf(log, ANALYTICS)).toEqual({ agentId: PROBE });
    expect(callsTo(log, ANALYTICS)[0]?.confirmed).toBe(false);
    expect(result).toMatchObject({ agent: { agentId: PROBE }, ...FULL });
  });

  it("reads omitted zeros, false flags and empty lists from a bare reply", async () => {
    const bare = await run("analytics", {}, { [ANALYTICS]: [{}] });
    expect(bare.result).toMatchObject({
      weeklyActiveUsers: 0,
      totalMinutesSaved: 0,
      minutesSavedBeforeWindow: 0,
      minutesSavedMeasured: false,
      days: [],
      topUsers: [],
    });
    const sparse = await run(
      "analytics",
      {},
      {
        [ANALYTICS]: [
          {
            weeklyActiveUsers: "3",
            totalMinutesSaved: "12.5",
            days: [{ day: "2026-10-21" }],
            topUsers: [{ userId: 5 }],
          },
        ],
      },
    );
    expect(sparse.result).toMatchObject({
      weeklyActiveUsers: 3,
      totalMinutesSaved: 12.5,
      days: [
        {
          day: "2026-10-21",
          activeUsers: 0,
          trailingSevenDayActiveUsers: 0,
          userTurns: 0,
          minutesSaved: 0,
        },
      ],
      topUsers: [
        {
          userId: 5,
          displayName: "",
          userTurns: 0,
          minutesSaved: 0,
          isExternal: false,
        },
      ],
    });
  });

  it.each<[unknown, string]>([
    [[], "the reply is not an object"],
    [{ days: "none" }, "days is not a list"],
    [{ topUsers: [1] }, "topUsers[0] is not an object"],
    [
      { weeklyActiveUsers: "many" },
      "weeklyActiveUsers is not a non-negative integer",
    ],
    [{ days: [{ userTurns: -1 }] }, "userTurns is not a non-negative integer"],
    [{ totalMinutesSaved: "lots" }, "totalMinutesSaved is not a number"],
  ])("fails with a protocol error on %j", async (reply, problem) => {
    const { result } = await run("analytics", {}, { [ANALYTICS]: [reply] });
    expect(result).toEqual(["protocol", `${ANALYTICS}: ${problem}`]);
  });

  it("passes the server's 404 for a personal bot through in plain words, from its detail", async () => {
    // The live 404 says only "Error" in message; the sentence is in details[].debug.details.
    const error = await refused(
      ANALYTICS,
      404,
      refusalBody("not_found", "Error", "Grok Bot agent not found."),
    );
    const { result } = await run(
      "analytics",
      {},
      {
        [ANALYTICS]: throwing(error),
      },
    );
    expect(result).toEqual([
      "not-found",
      "GetGrokBotAgentAnalytics for Team Probe was refused with HTTP 404: Grok Bot agent not found. Analytics seem to exist only for Team Bots.",
    ]);
  });

  it.each([
    ["a body that is plain text", "Not for you", "Not for you."],
    [
      "a body cut off at the length limit",
      `{"code":"permission_denied","message":"${"x".repeat(400)}"}`,
      `${"x".repeat(300 - '{"code":"permission_denied","message":"'.length)}.`,
    ],
  ])("explains %s", async (_label, body, sentence) => {
    const error = await refused(ANALYTICS, 403, body);
    const { result } = await run(
      "analytics",
      {},
      {
        [ANALYTICS]: throwing(error),
      },
    );
    expect(result).toEqual([
      "http",
      `GetGrokBotAgentAnalytics for Team Probe was refused with HTTP 403: ${sentence} Analytics seem to exist only for Team Bots.`,
    ]);
  });

  it.each<[string, number, string]>([
    ["an empty 404", 404, ""],
    ["a server error", 500, '{"message":"boom"}'],
  ])("leaves %s as the transport made it", async (_label, status, body) => {
    const error = await refused(ANALYTICS, status, body);
    const { result } = await run(
      "analytics",
      {},
      {
        [ANALYTICS]: throwing(error),
      },
    );
    expect(result).toEqual(["http", (error as Error).message]);
  });
});

describe("suggestions", () => {
  it("lists what the roster carries for the bot, in one roster call", async () => {
    const { result, calls } = await run("suggestions", {});
    expect(calls).toEqual(["ListGrokBotAgents"]);
    expect(result).toMatchObject({
      agent: { agentId: PROBE },
      suggestions: [{ ...SUGGESTIONS[0] }, { ...SUGGESTIONS[1], detail: "" }],
    });
  });

  it("returns none for a bot without any", async () => {
    const { result } = await run("suggestions", { agent: "Grok Bot" });
    expect(result).toMatchObject({
      agent: { agentId: MAIN },
      suggestions: [],
    });
  });
});

describe("suggestions-dismiss", () => {
  const DISMISS = "DismissGrokBotAgentSuggestions";
  const dismiss = (fields: JsonObject, server: Script = {}) =>
    run(
      "suggestions-dismiss",
      { suggestion: ["sg-1"], reason: "hidden", ...fields },
      { [DISMISS]: [{}], ...server },
    );

  it("closes the named suggestions as hidden, without needing --yes", async () => {
    const { result, log } = await dismiss({ suggestion: ["sg-2", "sg-1"] });
    expect(callsTo(log, DISMISS)).toEqual([
      {
        via: "server",
        method: DISMISS,
        body: {
          agentId: PROBE,
          suggestionIds: ["sg-2", "sg-1"],
          reason: "GROK_BOT_AGENT_SUGGESTION_DISMISS_REASON_HIDDEN",
        },
        confirmed: false,
      },
    ]);
    expect(result).toMatchObject({
      agent: { agentId: PROBE },
      reason: "hidden",
      dismissed: [{ id: "sg-2" }, { id: "sg-1" }],
    });
  });

  it("sends --reason acted in any case, each id once and trimmed", async () => {
    const { result, log } = await dismiss({
      reason: " Acted ",
      suggestion: [" sg-1", "sg-1 ", "sg-1"],
    });
    expect(bodyOf(log, DISMISS)).toEqual({
      agentId: PROBE,
      suggestionIds: ["sg-1"],
      reason: "GROK_BOT_AGENT_SUGGESTION_DISMISS_REASON_ACTED",
    });
    expect(result).toMatchObject({
      reason: "acted",
      dismissed: [{ id: "sg-1" }],
    });
  });

  it("refuses an id the roster does not list, naming the ones it does, before any change", async () => {
    const { result, calls } = await dismiss({
      suggestion: ["sg-1", "sg-9", "sg-8"],
    });
    expect([result, calls]).toEqual([
      [
        "not-found",
        'Team Probe has no suggestion "sg-9", "sg-8". Its suggestions: sg-1, sg-2. grokbot suggestions lists them.',
      ],
      ["ListGrokBotAgents"],
    ]);
  });

  it("refuses when the bot has no suggestions at all", async () => {
    const { result, calls } = await dismiss({
      agent: "Grok Bot",
      "force-protected": MAIN,
    });
    expect([result, calls]).toEqual([
      ["not-found", "Grok Bot has no suggestions to dismiss."],
      ["ListGrokBotAgents"],
    ]);
  });

  it("refuses an empty or blank id list from an SDK caller before any change", async () => {
    const { result, calls } = await dismiss({ suggestion: ["  "] });
    expect([result, calls]).toEqual([
      [
        "safety",
        "Pass at least one suggestion id with --suggestion (from grokbot suggestions).",
      ],
      ["ListGrokBotAgents"],
    ]);
  });

  it("refuses an unknown --reason before any call", async () => {
    const { result, calls } = await dismiss({ reason: "later" });
    expect([result, calls]).toEqual([
      ["safety", '--reason must be one of hidden, acted, not "later".'],
      [],
    ]);
  });

  it("refuses a protected bot unless --force-protected is its full agentId", async () => {
    const refusedRun = await dismiss({ agent: "Staff Test" });
    expect([refusedRun.result, refusedRun.calls]).toEqual([
      [
        "safety",
        `Staff Test (${STAFF.slice(0, 8)}) is protected, so suggestions-dismiss refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
      ],
      ["ListGrokBotAgents"],
    ]);
    const allowed = await dismiss({
      agent: "Staff Test",
      "force-protected": STAFF,
    });
    expect(allowed.calls).toEqual(["ListGrokBotAgents", DISMISS]);
  });
});

describe("describeReviewChange", () => {
  it("says each change in plain words", () => {
    expect([
      describeReviewChange({
        kind: "memory",
        action: "write",
        memoryType: "fact",
        text: "Standup is at 9:30",
      }),
      describeReviewChange({
        kind: "memory",
        action: "forget",
        memoryType: "",
        text: "",
      }),
      describeReviewChange({
        kind: "skill",
        action: "add",
        name: "weekly-report",
        description: "Weekly report",
        content: "Write\n  it.",
      }),
      describeReviewChange({
        kind: "skill",
        action: "remove",
        name: "weekly-report",
        description: "Weekly report",
        content: "Write it.",
      }),
      describeReviewChange({
        kind: "folder-memory",
        action: "write",
        memoryType: "note",
        path: "projects/alpha.md",
        text: "plan",
        metaJson: "",
      }),
      describeReviewChange({ kind: "unknown" }),
    ]).toEqual([
      ['Add a memory (fact): "Standup is at 9:30"'],
      ["Forget a memory"],
      ['Add the skill weekly-report: "Weekly report"', "Content: Write it."],
      ["Remove the skill weekly-report"],
      ['Add to the memory folder projects/alpha.md (note): "plan"'],
      ["A change this grokbot does not recognise (see --json)."],
    ]);
  });

  it("cuts long proposed text to one line of at most the limit, with an ellipsis", () => {
    const text = `${"word ".repeat(100)}\nend`;
    const [line] = describeReviewChange(
      { kind: "memory", action: "write", memoryType: "", text },
      20,
    );
    expect(line).toBe('Add a memory: "word word word word…"');
    expect(clipText("short  text", 20)).toBe("short text");
    expect([...clipText("é".repeat(30), 10)]).toHaveLength(10);
  });
});
