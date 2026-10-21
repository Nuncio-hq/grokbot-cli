import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  CLOUD_AGENT_ID,
  isCloudAgentActive,
  isLaunchedBy,
  parseCloudAgentInfo,
  parseConversation,
  parseSnapshotFrame,
} from "./governance-cloud-agents.js";

const BC = "bc-00000000-0000-4000-8000-0000000000a1";
const WORKFLOW = "CLOUD_AGENT_WORKFLOW_STATUS_";
const COMPOSER = "BACKGROUND_COMPOSER_STATUS_";

const row = (over: Record<string, unknown> = {}) => ({
  bcId: BC,
  name: "Fix the flaky test",
  repoUrl: "https://example.test/acme/widgets",
  branchName: "cursor/fix-flaky",
  updatedAtMs: 1_790_000_000_000,
  workflowStatus: `${WORKFLOW}IDLE`,
  ...over,
});

const frame = (composers: unknown[], list: Record<string, unknown> = {}) => ({
  snapshot: { list: { composers, ...list }, resumeCursor: "cursor-1" },
});

const statusOfRow = (over: Record<string, unknown>) =>
  parseSnapshotFrame(frame([row(over)]))?.agents[0]?.status;

describe("status mapping", () => {
  it.each([
    ["RUNNING", "running"],
    ["WAITING_FOR_BACKGROUND_WORK", "running"],
    ["ERROR", "error"],
    ["IDLE", "finished"],
    ["ARCHIVED", "finished"],
    ["EXPIRED", "expired"],
    ["NOT_YET_STARTED", "creating"],
  ])("maps workflow status %s like the app: %s", (name, expected) => {
    expect(statusOfRow({ workflowStatus: `${WORKFLOW}${name}` })).toBe(
      expected,
    );
  });

  it("falls back to the plain status when the workflow status is unset or unknown", () => {
    expect([
      statusOfRow({
        workflowStatus: undefined,
        status: `${COMPOSER}RUNNING`,
      }),
      statusOfRow({
        workflowStatus: `${WORKFLOW}UNSPECIFIED`,
        status: `${COMPOSER}ERROR`,
      }),
      statusOfRow({ workflowStatus: undefined, status: undefined }),
    ]).toEqual(["running", "error", "unknown"]);
  });

  it("keeps the workflow status over a stale plain one", () => {
    expect(
      statusOfRow({
        workflowStatus: `${WORKFLOW}RUNNING`,
        status: `${COMPOSER}FINISHED`,
      }),
    ).toBe("running");
  });

  it("treats only running and creating as still active", () => {
    expect(
      (
        [
          "creating",
          "running",
          "finished",
          "error",
          "expired",
          "unknown",
        ] as const
      ).filter(isCloudAgentActive),
    ).toEqual(["creating", "running"]);
  });
});

describe("parseSnapshotFrame", () => {
  it("maps a snapshot row to the summary the list shows", () => {
    const snapshot = parseSnapshotFrame(
      frame(
        [
          row({
            prStatus: "PR_STATUS_OPEN",
            prUrl: "https://example.test/acme/widgets/pull/7",
            createdAtMs: "1789000000000",
            lastMessageActivityAtMs: 1_790_000_100_000,
          }),
        ],
        { hasMore: true },
      ),
    );
    expect(snapshot).toEqual({
      hasMore: true,
      agents: [
        {
          bcId: BC,
          name: "Fix the flaky test",
          status: "finished",
          repo: "https://example.test/acme/widgets",
          branch: "cursor/fix-flaky",
          prStatus: "open",
          prUrl: "https://example.test/acme/widgets/pull/7",
          updatedAtMs: 1_790_000_000_000,
          createdAtMs: 1_789_000_000_000,
          lastActivityAtMs: 1_790_000_100_000,
          needsYou: false,
        },
      ],
    });
  });

  it("reads absent fields as empty, never as missing", () => {
    expect(parseSnapshotFrame(frame([{ bcId: BC }]))?.agents[0]).toEqual({
      bcId: BC,
      name: "",
      status: "unknown",
      repo: "",
      branch: "",
      prStatus: null,
      prUrl: "",
      updatedAtMs: null,
      createdAtMs: null,
      lastActivityAtMs: null,
      needsYou: false,
    });
  });

  it("reads the pending interaction flag of a row, absent meaning false as the server leaves false out", () => {
    const needs = (extra: Record<string, unknown>) =>
      parseSnapshotFrame(frame([row(extra)]))?.agents[0]?.needsYou;
    expect([
      needs({ hasPendingInteraction: true }),
      needs({ hasPendingInteraction: false }),
      needs({}),
    ]).toEqual([true, false, false]);
  });

  it("reports a merged pull request from the flag when the status is unset", () => {
    expect(
      parseSnapshotFrame(frame([row({ isPrMerged: true })]))?.agents[0]
        ?.prStatus,
    ).toBe("merged");
  });

  it("skips rows without an id, and is not fooled by a frame that is no snapshot", () => {
    expect([
      parseSnapshotFrame(frame([{ name: "no id" }, row()]))?.agents.length,
      parseSnapshotFrame({ heartbeat: { resumeCursor: "c" } }),
      parseSnapshotFrame({ event: { event: { bcId: BC } } }),
      parseSnapshotFrame("nope"),
    ]).toEqual([1, undefined, undefined, undefined]);
  });

  it("lists nothing, without more, for a snapshot of an empty account", () => {
    expect(parseSnapshotFrame({ snapshot: { list: {} } })).toEqual({
      agents: [],
      hasMore: false,
    });
  });
});

describe("parseCloudAgentInfo", () => {
  const reply = (inner: Record<string, unknown>, outer = {}) => ({
    composer: { composer: inner, baseBranch: "main", ...outer },
  });

  it("maps the detail: status, repo, branch, pull request, changes and model", () => {
    const info = parseCloudAgentInfo(
      reply(
        row({
          prStatus: "PR_STATUS_MERGED",
          prUrl: "https://example.test/acme/widgets/pull/7",
          linesAdded: 120,
          linesRemoved: 8,
          filesChanged: 5,
          modelDetails: { modelName: "example-model", maxMode: true },
          source: "BACKGROUND_COMPOSER_SOURCE_GROK_BOT",
          createdAtMs: 1_789_000_000_000,
          lastMessageActivityAtMs: 1_790_000_100_000,
        }),
      ),
      BC,
    );
    expect(info).toEqual({
      bcId: BC,
      name: "Fix the flaky test",
      status: "finished",
      repo: "https://example.test/acme/widgets",
      branch: "cursor/fix-flaky",
      baseBranch: "main",
      prStatus: "merged",
      prUrl: "https://example.test/acme/widgets/pull/7",
      linesAdded: 120,
      linesRemoved: 8,
      filesChanged: 5,
      model: { name: "example-model", maxMode: true },
      source: "grok_bot",
      updatedAtMs: 1_790_000_000_000,
      createdAtMs: 1_789_000_000_000,
      lastActivityAtMs: 1_790_000_100_000,
      needsYou: false,
    });
  });

  it("takes the pull request from the detail's list when the composer carries none", () => {
    const info = parseCloudAgentInfo(
      reply(row(), {
        prs: [
          {
            prStatus: "PR_STATUS_DRAFT",
            prUrl: "https://example.test/acme/widgets/pull/9",
          },
        ],
      }),
      BC,
    );
    expect([info.prStatus, info.prUrl]).toEqual([
      "draft",
      "https://example.test/acme/widgets/pull/9",
    ]);
  });

  it("reports no model and zero changes when the server sends none", () => {
    const info = parseCloudAgentInfo(reply({ bcId: BC }), BC);
    expect([
      info.model,
      info.linesAdded,
      info.linesRemoved,
      info.filesChanged,
    ]).toEqual([null, 0, 0, 0]);
  });

  it("falls back to the id asked for when the reply omits it", () => {
    expect(parseCloudAgentInfo(reply({ name: "x" }), BC).bcId).toBe(BC);
  });

  it("refuses a reply with no composer", () => {
    expect(() => parseCloudAgentInfo({}, BC)).toThrow(
      new GrokBotError(
        "protocol",
        "GetBackgroundComposerInfo: the reply has no composer.",
      ),
    );
  });
});

describe("parseConversation", () => {
  const human = (text: string, over = {}) => ({
    type: "MESSAGE_TYPE_HUMAN",
    bubbleId: `h-${text}`,
    text,
    ...over,
  });
  const ai = (text: string, over = {}) => ({
    type: "MESSAGE_TYPE_AI",
    bubbleId: `a-${text}`,
    text,
    ...over,
  });
  const parse = (conversation: unknown[]) =>
    parseConversation({ conversation }).map((m) => `${m.role}:${m.text}`);

  it("maps human and AI messages to human and assistant, in order", () => {
    expect(parse([human("fix it"), ai("done")])).toEqual([
      "human:fix it",
      "assistant:done",
    ]);
  });

  it("drops what a person would not read: thinking, tool results, blanks, steering and wake-ups", () => {
    expect(
      parse([
        human("start"),
        ai("", { thinking: { text: "hm" } }),
        ai("calling a tool", { toolResults: [{ name: "grep" }] }),
        ai("thought out loud", { thinking: { text: "hm" } }),
        ai("   "),
        human("steer now", { turnSteer: true }),
        human("woke up", { isSimulatedMsg: true }),
        ai("all good"),
      ]),
    ).toEqual(["human:start", "assistant:all good"]);
  });

  it("keeps an agent's send-message even when the bubble also holds tool results", () => {
    expect(
      parse([
        ai("sent to the user", {
          bubbleId: "b1:send-message",
          toolResults: [{ name: "send" }],
        }),
      ]),
    ).toEqual(["assistant:sent to the user"]);
  });

  it("reads an empty or missing conversation as no messages, and refuses a non-object", () => {
    expect([
      parseConversation({}),
      parseConversation({ conversation: [] }),
    ]).toEqual([[], []]);
    expect(() => parseConversation("nope")).toThrow(GrokBotError);
  });

  it("ignores message types it does not know", () => {
    expect(parse([{ type: "MESSAGE_TYPE_UNSPECIFIED", text: "x" }])).toEqual(
      [],
    );
  });
});

describe("isLaunchedBy", () => {
  const BOT = "5ca1ab1e-0000-4000-8000-0000000000b1";
  const watch = (agentId: string, kind: string) => ({
    agentId,
    kind: `GROK_BOT_CLOUD_AGENT_WATCH_KIND_${kind}`,
    durable: true,
  });

  it("counts only a launch watch held by that bot", () => {
    expect([
      isLaunchedBy({ watchers: [watch(BOT, "LAUNCH")] }, BOT),
      isLaunchedBy({ watchers: [watch(BOT, "REPLY")] }, BOT),
      isLaunchedBy({ watchers: [watch(BOT, "WATCH")] }, BOT),
      isLaunchedBy({ watchers: [watch("other", "LAUNCH")] }, BOT),
      isLaunchedBy(
        { watchers: [watch("other", "LAUNCH"), watch(BOT, "LAUNCH")] },
        BOT,
      ),
      isLaunchedBy({}, BOT),
      isLaunchedBy(undefined, BOT),
    ]).toEqual([true, false, false, false, true, false, false]);
  });
});

describe("CLOUD_AGENT_ID", () => {
  it.each([
    [BC, true],
    ["bc-abc_DEF-123", true],
    ["00000000-0000-4000-8000-0000000000a1", false],
    ["bc-", false],
    ["bc-has space", false],
    ["bc-../../etc", false],
    ["BC-abc", false],
    ["", false],
    [`bc-${"a".repeat(97)}`, false],
  ])("%s -> %s", (id, ok) => {
    expect(CLOUD_AGENT_ID.test(id)).toBe(ok);
  });
});
