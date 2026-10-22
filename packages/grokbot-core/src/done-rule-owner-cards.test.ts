import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { describeCard, OWNER_ONLY_NOTE } from "./card-descriptions.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  assistantRow,
  sendMessageRow,
  textReplyRow,
  userRow,
  wireEntry,
  withEntryId,
} from "./fixtures/wire-entries.js";

const ID = "m-owner-card";
const echo = withEntryId(
  userRow(1, "Order me a USB-C cable", { clientNonce: ID, requestId: "r1" }),
  "t7u",
);
const FORM = {
  type: "user-form",
  formRequest: { title: "Shipping address", fields: [{}, {}] },
};
const note = textReplyRow(2, "I need your shipping address first.", "r1");
const form = withEntryId(sendMessageRow(3, FORM, "r1"), "t7s0");
const submitted = withEntryId(
  sendMessageRow(3, FORM, "r1", 4, { formResolution: "submitted" }),
  "t7s0",
);
const ordered = withEntryId(textReplyRow(5, "Ordered.", "r2"), "t7s1");

const HANDOFF = { requestId: "h-1", instruction: "Sign in to Xero" };
const handingOff: LiveStatus = { ...IDLE_STATUS, boxHandoff: HANDOFF };
const askHelp = textReplyRow(2, "Please sign in on my computer.", "r1");
const laterOwner = userRow(6, "Also check the invoices", {
  clientNonce: "m-later",
  requestId: "r9",
});

describe("Done Rule on cards only the owner can answer", () => {
  it("awaits a Secure Form instead of calling the note before it the final reply", () => {
    const v = verdict([echo, note, form], IDLE_STATUS, ID);
    expect(
      v.status === "awaiting-approval" && [
        v.reason,
        v.cards.map((c) => [c.seq, c.cardType]),
      ],
    ).toEqual([
      'Secure Form "Shipping address" (2 fields)',
      [["3", "user-form"]],
    ]);
  });

  it("is done with the reply of the run that resumes after the form is submitted", () => {
    expect(summary([echo, note, submitted, ordered], IDLE_STATUS, ID)).toBe(
      "done:Ordered.",
    );
  });

  it("keeps a retryable credential request open", () => {
    const login = (extra: Record<string, unknown>) =>
      sendMessageRow(
        3,
        {
          type: "credential-request",
          credentialRequest: { kind: "vault-login" },
        },
        "r1",
        3,
        extra,
      );
    expect([
      summary(
        [echo, login({ credentialResolution: "retryable" })],
        IDLE_STATUS,
        ID,
      ),
      summary(
        [echo, login({ credentialResolution: "denied" })],
        IDLE_STATUS,
        ID,
      ),
    ]).toEqual(["awaiting-approval:3", "running:awaiting-final-reply"]);
  });

  it("awaits a rule-change widget as an owner-only card until it is answered or dismissed", () => {
    const rule = (extra: Record<string, unknown> = {}) =>
      sendMessageRow(
        3,
        {
          type: "widget",
          widget: {
            prompt: "Save this rule?",
            options: [{ label: "Save" }, { label: "Cancel" }],
            ruleChange: {
              kind: "update",
              effect: "ask_first",
              text: "Send email to clients",
              replaces: "Send email",
            },
          },
        },
        "r1",
        3,
        extra,
      );
    const v = verdict([echo, rule()], IDLE_STATUS, ID);
    const card = v.status === "awaiting-approval" ? v.cards[0] : undefined;
    expect([
      v.status === "awaiting-approval" && v.reason,
      card && describeCard(card.cardType, card.message).ownerOnly,
      summary(
        [echo, rule({ respondedValue: "Updated the rule." })],
        IDLE_STATUS,
        ID,
      ),
      summary([echo, rule({ widgetDismissed: true })], IDLE_STATUS, ID),
    ]).toEqual([
      'The bot proposes a rule update: "Ask first: Send email to clients" (replaces "Send email")',
      true,
      "running:awaiting-final-reply",
      "running:awaiting-final-reply",
    ]);
  });

  it("awaits an appearance picker until the owner answers it", () => {
    const picker = (extra: Record<string, unknown> = {}) =>
      sendMessageRow(3, { type: "appearance-picker" }, "r1", 3, extra);
    const v = verdict([echo, picker()], IDLE_STATUS, ID);
    const card = v.status === "awaiting-approval" ? v.cards[0] : undefined;
    expect([
      v.status === "awaiting-approval" && v.reason,
      card && describeCard(card.cardType, card.message).ownerOnly,
      summary(
        [echo, picker({ respondedValue: '{"avatarShape":"circle"}' })],
        IDLE_STATUS,
        ID,
      ),
    ]).toEqual([
      "The bot offers you a look for itself (shape and colour)",
      true,
      "running:awaiting-final-reply",
    ]);
  });

  it("awaits an email offer until the owner answers it or the bot replaces the address", () => {
    const offer = (
      extra: Record<string, unknown> = {},
      message: Record<string, unknown> = {},
    ) =>
      sendMessageRow(
        3,
        {
          type: "email-offer",
          email: "bot@example.com",
          site: "shop.example.com",
          ...message,
        },
        "r1",
        3,
        extra,
      );
    const v = verdict([echo, offer()], IDLE_STATUS, ID);
    const card = v.status === "awaiting-approval" ? v.cards[0] : undefined;
    expect([
      v.status === "awaiting-approval" && v.reason,
      card && describeCard(card.cardType, card.message).ownerOnly,
      summary(
        [echo, offer({ respondedValue: "email-offer:not-now" })],
        IDLE_STATUS,
        ID,
      ),
      summary([echo, offer({}, { replaced: true })], IDLE_STATUS, ID),
    ]).toEqual([
      "The bot offers an email address of its own: bot@example.com (for shop.example.com)",
      true,
      "running:awaiting-final-reply",
      "running:awaiting-final-reply",
    ]);
  });
});

describe("Done Rule on connector and repo-connect cards", () => {
  const ID = "m-connect";
  const echo = withEntryId(
    userRow(1, "Email the notes", { clientNonce: ID, requestId: "r1" }),
    "t8u",
  );
  const gmail = sendMessageRow(
    3,
    { type: "connector", connector: "Gmail", variant: "suggested" },
    "r1",
  );
  const github = sendMessageRow(
    3,
    {
      type: "scm-connect",
      provider: "github",
      intent: "read",
      reason: "the repo",
    },
    "r1",
  );
  const sent = textReplyRow(5, "Sent the notes.", "r1");
  const note = textReplyRow(2, "I need Gmail first.", "r1");

  it("is done with the later reply in the same turn", () => {
    expect([
      summary([echo, gmail, sent], IDLE_STATUS, ID),
      summary([echo, github, sent], IDLE_STATUS, ID),
    ]).toEqual(["done:Sent the notes.", "done:Sent the notes."]);
  });

  it("awaits the owner when the card is the last bot row and the bot is idle", () => {
    const v = verdict([echo, note, gmail], IDLE_STATUS, ID);
    const card = v.status === "awaiting-approval" ? v.cards[0] : undefined;
    expect(
      v.status === "awaiting-approval" &&
        card !== undefined && [
          v.reason,
          describeCard(card.cardType, card.message),
          OWNER_ONLY_NOTE,
        ],
    ).toEqual([
      "Connect Gmail",
      { text: "Connect Gmail", ownerOnly: true },
      "only the owner can answer this in the GrokBot app",
    ]);
    const repo = verdict([echo, github], IDLE_STATUS, ID);
    expect(
      repo.status === "awaiting-approval" && [
        repo.reason,
        repo.cards.map((c) => c.seq),
      ],
    ).toEqual(["Connect a code host (github)", ["3"]]);
  });

  it("stays awaiting when live.awaiting is set even after the bot goes idle", () => {
    const awaiting: LiveStatus = {
      ...IDLE_STATUS,
      awaiting: { reason: "Connect Gmail" },
    };
    const running = { ...awaiting, isRunning: true };
    expect([
      summary([echo, gmail], awaiting, ID),
      summary([echo, gmail], running, ID),
      summary([echo, gmail], { ...IDLE_STATUS, isRunning: true }, ID),
    ]).toEqual([
      "awaiting-approval:3",
      "awaiting-approval:3",
      "running:target-active",
    ]);
  });

  it("keeps the connector card blocking when a later reply exists and live.awaiting is set", () => {
    const notion = sendMessageRow(
      3,
      { type: "connector", connector: "Notion", variant: "suggested" },
      "r1",
    );
    const reply = textReplyRow(
      4,
      "I sent a connect card above; I'll continue once Notion is connected",
      "r1",
    );
    const awaiting: LiveStatus = {
      ...IDLE_STATUS,
      awaiting: { reason: "Connect Notion" },
    };
    const v = verdict([echo, notion, reply], awaiting, ID);
    const card = v.status === "awaiting-approval" ? v.cards[0] : undefined;
    expect(
      v.status === "awaiting-approval" &&
        card !== undefined && [
          v.reason,
          card.seq,
          card.cardType,
          describeCard(card.cardType, card.message),
        ],
    ).toEqual([
      "Connect Notion",
      "3",
      "connector",
      { text: "Connect Notion", ownerOnly: true },
    ]);
  });

  it("keeps only the newest positional card while live.awaiting is set", () => {
    const repo = sendMessageRow(
      4,
      { type: "scm-connect", provider: "github" },
      "r1",
    );
    const reply = textReplyRow(5, "Waiting on the repo.", "r1");
    const awaiting: LiveStatus = {
      ...IDLE_STATUS,
      awaiting: { reason: "Connect a code host" },
    };
    const v = verdict([echo, gmail, repo, reply], awaiting, ID);
    expect(
      v.status === "awaiting-approval" &&
        v.cards.map((c) => [c.seq, c.cardType]),
    ).toEqual([["4", "scm-connect"]]);
  });

  it("treats a tool call or a later message as the card having passed", () => {
    const tool = wireEntry(4, "tool-call", {
      kind: "tool-call",
      name: "shell",
    });
    const message = assistantRow(4, "Checking Gmail.", { requestId: "r1" });
    expect([
      summary([echo, gmail, tool], IDLE_STATUS, ID),
      summary([echo, gmail, message], IDLE_STATUS, ID),
      summary([echo, gmail, tool, sent], IDLE_STATUS, ID),
    ]).toEqual([
      "running:awaiting-final-reply",
      "running:awaiting-final-reply",
      "done:Sent the notes.",
    ]);
  });

  it("still awaits a connector-grant, which closes by status rather than position", () => {
    const grant = sendMessageRow(
      3,
      {
        type: "connector-grant",
        ask: { serverName: "Linear", status: "pending" },
      },
      "r1",
    );
    expect(summary([echo, grant, sent], IDLE_STATUS, ID)).toBe(
      "awaiting-approval:3",
    );
  });
});

describe("Done Rule on a pending box hand-off", () => {
  it("awaits the owner instead of settling done on the reply before the hand-off", () => {
    const v = verdict([echo, askHelp], handingOff, ID);
    expect(v).toEqual({
      status: "awaiting-approval",
      reason: "Take over the bot's computer: Sign in to Xero",
      cards: [],
      handoff: HANDOFF,
    });
  });

  it("keeps running while the bot still works, and awaits even when live.awaiting has no card", () => {
    const awaiting = { ...handingOff, awaiting: { reason: "Hand-off" } };
    expect([
      summary([echo, askHelp], { ...handingOff, isRunning: true }, ID),
      summary([echo, askHelp], awaiting, ID),
    ]).toEqual(["running:target-active", "awaiting-approval:"]);
  });

  it("holds our unanswered message while a hand-off is pending", () => {
    expect(summary([echo], handingOff, ID)).toBe("awaiting-approval:");
  });

  it("known limit: holds our answered turn when nothing after it shows whose the hand-off is", () => {
    expect(summary([echo, askHelp], handingOff, ID)).toBe("awaiting-approval:");
  });

  it("names the hand-off too when a card of the turn also awaits the owner", () => {
    const v = verdict(
      [echo, note, form],
      { ...handingOff, awaiting: { reason: "Shipping address" } },
      ID,
    );
    expect(v.status === "awaiting-approval" && v.handoff).toEqual(HANDOFF);
  });

  it("settles on the reply of the run that resumes after the hand-off ends", () => {
    const resumed = withEntryId(
      textReplyRow(7, "Signed in; done.", "r2"),
      "t7s1",
    );
    expect(
      summary([echo, withEntryId(askHelp, "t7s0"), resumed], IDLE_STATUS, ID),
    ).toBe("done:Signed in; done.");
  });

  it("settles our answered turn when the owner wrote to an idle bot after it, since the hand-off is not ours", () => {
    const laterSentIdle = new Map([["m-later", false]]);
    expect([
      summary([echo, askHelp, laterOwner], handingOff, ID, laterSentIdle),
      summary([echo, askHelp, laterOwner], handingOff, ID),
    ]).toEqual(["done:Please sign in on my computer.", "awaiting-approval:"]);
  });
});
