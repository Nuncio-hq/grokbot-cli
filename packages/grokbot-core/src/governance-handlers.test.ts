import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  governanceRunner,
  PRIMARY,
  realGovernanceRunner,
  STAFF,
} from "./fixtures/governance-test-kit.js";
import { sendMessageRow } from "./fixtures/wire-entries.js";

const widgetRow = sendMessageRow(4, {
  type: "widget",
  widget: { prompt: "Pick a color", options: [{ label: "Blue" }] },
});
const autoReviewRow = sendMessageRow(7, {
  type: "auto-review-approval",
  approval: {
    requestId: "ar-1",
    status: "pending",
    summary: "Risky",
    command: "rm -rf x",
  },
});
const entries = (...rows: unknown[]) => [{ entries: rows }];
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof GrokBotError ? [error.code, error.message] : error;
};

describe("approvals", () => {
  it("lists open cards per agent, skipping rooms and quiet agents", async () => {
    const { run, log } = governanceRunner({
      ListGrokBotAgentStatuses: [
        {
          statuses: [
            { agentId: STAFF, live: { awaiting: { reason: "Approve" } } },
          ],
        },
      ],
      ListGrokBotTranscriptEntries: (body) =>
        body.agentId === PRIMARY ? { entries: [widgetRow] } : { entries: [] },
    });
    const out = await run("approvals", { json: false });
    expect(
      out.agents.map((a) => [
        a.agent.name,
        a.awaiting,
        a.cards.map((c) => c.entryId),
      ]),
    ).toEqual([
      ["Primary Test", null, ["entry-4"]],
      ["Staff Test", "Approve", []],
    ]);
    expect(
      log.map((c) => [c.method, c.body.agentId ?? c.body.agentIds]),
    ).toEqual([
      ["ListGrokBotAgents", undefined],
      ["ListGrokBotAgentStatuses", [PRIMARY, STAFF]],
      ["ListGrokBotTranscriptEntries", PRIMARY],
      ["ListGrokBotTranscriptEntries", STAFF],
    ]);
  });
});

describe("answer", () => {
  it("answers the only open widget with the transcript row's entryId", async () => {
    const { run, log } = governanceRunner({
      ListGrokBotTranscriptEntries: entries(widgetRow),
      RespondGrokBotWidget: [{ accepted: true }],
    });
    const out = await run("answer", {
      value: "Blue",
      agent: "Primary Test",
      dismiss: false,
      json: false,
    });
    expect([out.card.entryId, out.dismissed, out.value, log.at(-1)]).toEqual([
      "entry-4",
      false,
      "Blue",
      {
        via: "server",
        method: "RespondGrokBotWidget",
        body: { agentId: PRIMARY, entryId: "entry-4", value: "Blue" },
        confirmed: false,
      },
    ]);
  });

  it("dismisses with --dismiss and reports a refusal", async () => {
    const dismiss = governanceRunner({
      ListGrokBotTranscriptEntries: entries(widgetRow),
      DismissGrokBotWidget: [{ accepted: true }],
    });
    await dismiss.run("answer", { agent: PRIMARY, dismiss: true, json: false });
    const refused = governanceRunner({
      ListGrokBotTranscriptEntries: entries(widgetRow),
      RespondGrokBotWidget: [
        {
          accepted: false,
          refusal: { message: "Too late", failureCode: "EXPIRED" },
        },
      ],
    });
    expect([
      dismiss.log.at(-1)?.body,
      await failure(
        refused.run("answer", {
          value: "Red",
          agent: PRIMARY,
          dismiss: false,
          json: false,
        }),
      ),
      await failure(
        dismiss.run("answer", { agent: PRIMARY, dismiss: false, json: false }),
      ),
    ]).toEqual([
      { agentId: PRIMARY, entryId: "entry-4" },
      ["protocol", "RespondGrokBotWidget was refused: Too late (EXPIRED)"],
      ["not-found", "Pass the answer, e.g. grokbot answer Blue, or --dismiss."],
    ]);
  });
});

describe("approve and deny refuse without --yes", () => {
  it("throws before any network call, through the real runner", async () => {
    const { runner, log } = realGovernanceRunner();
    const card = { agent: STAFF, json: false, yes: false } as const;
    expect([
      await failure(runner.run("approve", { ...card, always: false })),
      await failure(runner.run("deny", card)),
      await failure(runner.run("worker-start", { yes: false, json: false })),
      log,
    ]).toEqual([
      ["safety", "approve changes or deletes live data. Re-run with --yes."],
      ["safety", "deny changes or deletes live data. Re-run with --yes."],
      [
        "safety",
        "worker-start changes or deletes live data. Re-run with --yes.",
      ],
      [],
    ]);
  });
});

const phoneRow = sendMessageRow(8, {
  type: "auto-review-approval",
  approval: {
    requestId: "ar-phone",
    status: "pending",
    summary: "place_phone_call",
    command: "",
    summaryCopy: {
      kind: "phone_call",
      params: { destination: "+1 555 0100", request: "Book a table for 2" },
    },
  },
});
const shareRow = sendMessageRow(9, {
  type: "auto-review-approval",
  approval: {
    requestId: "ar-share",
    status: "pending",
    surface: "bot_share",
    summary: "share_bot",
    command: JSON.stringify({ name: "Research Bot", visibility: "public" }),
  },
});
const resolves = (log: { method: string }[]) =>
  log.filter((call) => call.method.startsWith("Resolve")).map((c) => c.method);

describe("approve refuses owner-only cards before any resolve call", () => {
  it("refuses a phone call with --yes and does not resolve it", async () => {
    const { run, log } = governanceRunner({
      ListGrokBotTranscriptEntries: entries(phoneRow),
      ResolveGrokBotAutoReviewApproval: [{ dispatched: true }],
    });
    expect([
      await failure(
        run("approve", { agent: STAFF, always: false, yes: true, json: false }),
      ),
      resolves(log),
    ]).toEqual([
      [
        "safety",
        "Phone call to +1 555 0100: Book a table for 2: only the owner can answer this in the GrokBot app.",
      ],
      [],
    ]);
  });

  it("refuses a bot share with --always the same way", async () => {
    const { run, log } = governanceRunner({
      ListGrokBotTranscriptEntries: entries(shareRow),
      ResolveGrokBotAutoReviewApproval: [{ dispatched: true }],
    });
    expect([
      await failure(
        run("approve", { agent: STAFF, always: true, yes: true, json: false }),
      ),
      resolves(log),
    ]).toEqual([
      [
        "safety",
        'Share this bot as a template "Research Bot" (public): only the owner can answer this in the GrokBot app.',
      ],
      [],
    ]);
  });

  it("still denies a phone call", async () => {
    const { run, log } = governanceRunner({
      ListGrokBotTranscriptEntries: entries(phoneRow),
      ResolveGrokBotAutoReviewApproval: [{ dispatched: true }],
    });
    const denied = await run("deny", {
      agent: STAFF,
      yes: true,
      json: false,
    });
    expect([denied.resolution, resolves(log), log.at(-1)?.body]).toEqual([
      "denied",
      ["ResolveGrokBotAutoReviewApproval"],
      {
        agentId: STAFF,
        requestId: "ar-phone",
        resolution: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_DENIED",
        approvalPlatform: "desktop",
      },
    ]);
  });
});

describe("approve and deny an auto-review card", () => {
  it("sends the exact enum and desktop platform, confirmed, through the real runner", async () => {
    const { runner, log } = realGovernanceRunner({
      ListGrokBotTranscriptEntries: entries(autoReviewRow),
      ResolveGrokBotAutoReviewApproval: [{ dispatched: true, workflowId: "w" }],
    });
    const approved = await runner.run("approve", {
      agent: STAFF,
      always: true,
      yes: true,
      json: false,
    });
    const denied = await runner.run("deny", {
      agent: STAFF,
      yes: true,
      json: false,
    });
    expect([
      approved.resolution,
      denied.resolution,
      approved.wroteLocalApproval,
      log
        .filter((c) => c.method.startsWith("Resolve"))
        .map((c) => [c.body, c.confirmed]),
    ]).toEqual([
      "approved always",
      "denied",
      false,
      [
        [
          {
            agentId: STAFF,
            requestId: "ar-1",
            resolution: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_ALWAYS",
            approvalPlatform: "desktop",
          },
          true,
        ],
        [
          {
            agentId: STAFF,
            requestId: "ar-1",
            resolution: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_DENIED",
            approvalPlatform: "desktop",
          },
          true,
        ],
      ],
    ]);
  });

  it("reports a resolve the server did not dispatch", async () => {
    const { run } = governanceRunner({
      ListGrokBotTranscriptEntries: entries(autoReviewRow),
      ResolveGrokBotAutoReviewApproval: [{ dispatched: false }],
    });
    expect(
      await failure(run("deny", { agent: STAFF, yes: true, json: false })),
    ).toEqual([
      "protocol",
      "ResolveGrokBotAutoReviewApproval did not resolve card entry-7: not dispatched",
    ]);
  });
});
