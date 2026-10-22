import { describe, expect, it } from "vitest";
import {
  CLI_RESOLVABLE,
  describeBoxHandoff,
  describeCard,
} from "./card-descriptions.js";
import { CARD_TYPES, type CardType } from "./transcript.js";

/** Card messages shaped like the GrokBot app 0.71.2 renderer reads them. */
const MESSAGES: Record<CardType, Record<string, unknown>> = {
  widget: { widget: { prompt: "Pick a color", options: [] } },
  "secret-request": { secretRequest: { label: "OpenAI key" } },
  "auto-review-approval": {
    approval: { requestId: "a-1", status: "pending", summary: "Run rm -rf" },
  },
  "local-tool-permission": {
    ask: { action: "run-command", target: "ls -la", status: "pending" },
  },
  connector: { connector: "Gmail", variant: "suggested" },
  "scm-connect": { provider: "github" },
  "connector-grant": { ask: { serverName: "Linear", status: "pending" } },
  "user-form": {
    formRequest: { title: "Shipping address", fields: [{}, {}, {}] },
  },
  "credential-request": {
    credentialRequest: {
      kind: "brokered-login",
      goal: "Sign in to the store",
      entries: [{ website: "https://shop.example.com/login" }],
      accessRequestId: "x-1",
    },
  },
  "virtual-card-approval": {
    approval: { requestId: "v-1", status: "pending", title: "USB-C cable" },
  },
  "cookie-origin-approval": {
    approval: { requestId: "c-1", status: "pending" },
  },
  "meeting-join-consent": { approval: { requestId: "m-1", status: "pending" } },
  "mobile-tool-permission": {
    permission: { toolId: "MobileReadCalendar", machineLabel: "Phone" },
  },
  "appearance-picker": {},
  "email-offer": { email: "bot@example.com", site: "shop.example.com" },
};

describe("describeCard", () => {
  it("names every card kind in plain words and marks what only the owner can answer", () => {
    expect(
      CARD_TYPES.map((type) => {
        const { text, ownerOnly } = describeCard(type, MESSAGES[type]);
        return [type, text, ownerOnly];
      }),
    ).toEqual([
      ["widget", "Pick a color", false],
      ["secret-request", "Secret requested: OpenAI key", true],
      ["auto-review-approval", "Run rm -rf", false],
      ["local-tool-permission", "run-command: ls -la", false],
      ["connector", "Connect Gmail", true],
      ["scm-connect", "Connect a code host (github)", true],
      ["connector-grant", "Allow Linear for this turn", true],
      ["user-form", 'Secure Form "Shipping address" (3 fields)', true],
      ["credential-request", "Sign in to the store (shop.example.com)", true],
      ["virtual-card-approval", "Virtual card purchase: USB-C cable", true],
      [
        "cookie-origin-approval",
        "Use the owner's existing browser logins",
        true,
      ],
      [
        "meeting-join-consent",
        "Check in with the other meeting participants before the bot joins",
        true,
      ],
      [
        "mobile-tool-permission",
        "Permission on the owner's phone: MobileReadCalendar (Phone)",
        true,
      ],
      [
        "appearance-picker",
        "The bot offers you a look for itself (shape and colour)",
        true,
      ],
      [
        "email-offer",
        "The bot offers an email address of its own: bot@example.com (for shop.example.com)",
        true,
      ],
    ]);
    expect(CLI_RESOLVABLE).toEqual([
      "widget",
      "auto-review-approval",
      "local-tool-permission",
    ]);
  });

  it("describes a vault login fill and falls back when fields are missing", () => {
    expect([
      describeCard("credential-request", {
        credentialRequest: {
          kind: "vault-login",
          targetSite: "https://bank.example.com/",
          purpose: "download the statement",
        },
      }).text,
      describeCard("user-form", {}).text,
      describeCard("auto-review-approval", {}).text,
      describeCard("credential-request", {}).text,
    ]).toEqual([
      "Use a saved login for bank.example.com: download the statement",
      "Secure Form (0 fields)",
      "Approval needed",
      "Use a saved login",
    ]);
  });

  it("leaves phone calls and bot shares to the owner although they are auto-review approvals", () => {
    const phone = describeCard("auto-review-approval", {
      approval: {
        summary: "place_phone_call",
        summaryCopy: {
          kind: "phone_call",
          params: { destination: "+1 555 0100", request: "Book a table for 2" },
        },
      },
    });
    const share = describeCard("auto-review-approval", {
      approval: {
        surface: "bot_share",
        command: JSON.stringify({
          name: "Research Bot",
          avatar_shape: "circle",
          avatar_color: "blue",
          body: "...",
          visibility: "public",
        }),
      },
    });
    const brokenShare = describeCard("auto-review-approval", {
      approval: { surface: "bot_share", command: "not json" },
    });
    expect([phone, share, brokenShare]).toEqual([
      {
        text: "Phone call to +1 555 0100: Book a table for 2",
        ownerOnly: true,
      },
      {
        text: 'Share this bot as a template "Research Bot" (public)',
        ownerOnly: true,
      },
      { text: "Share this bot as a template", ownerOnly: true },
    ]);
  });

  it("describes a rule change in a widget as the owner's to apply, by kind and effect", () => {
    const ruleChange = (change: Record<string, unknown>) =>
      describeCard("widget", {
        widget: { prompt: "Save this rule?", ruleChange: change },
      });
    expect([
      ruleChange({ kind: "add", effect: "allow", text: "Run git status" }),
      ruleChange({ kind: "add", effect: "ask_first", text: "Send email" }),
      ruleChange({
        kind: "update",
        effect: "ask_first",
        text: "Send email to clients",
        replaces: "Send email",
      }),
      ruleChange({ kind: "delete", effect: "allow", text: "Run git status" }),
      ruleChange({ kind: "update", effect: "allow", text: "Run ls" }),
      describeCard("widget", { widget: { prompt: "Pick a color" } }),
    ]).toEqual([
      {
        text: 'The bot proposes a rule to add: "Allow without asking: Run git status"',
        ownerOnly: true,
      },
      {
        text: 'The bot proposes a rule to add: "Ask first: Send email"',
        ownerOnly: true,
      },
      {
        text: 'The bot proposes a rule update: "Ask first: Send email to clients" (replaces "Send email")',
        ownerOnly: true,
      },
      {
        text: 'The bot proposes to delete a rule: "Allow without asking: Run git status"',
        ownerOnly: true,
      },
      {
        text: 'The bot proposes a rule update: "Allow without asking: Run ls"',
        ownerOnly: true,
      },
      { text: "Pick a color", ownerOnly: false },
    ]);
  });

  it("describes an email offer with or without a site, and an appearance picker", () => {
    expect([
      describeCard("email-offer", { email: "bot@example.com" }).text,
      describeCard("email-offer", {}).text,
      describeCard("appearance-picker", {}),
    ]).toEqual([
      "The bot offers an email address of its own: bot@example.com",
      "The bot offers an email address of its own",
      {
        text: "The bot offers you a look for itself (shape and colour)",
        ownerOnly: true,
      },
    ]);
  });
});

describe("describeBoxHandoff", () => {
  it("says what the owner must do on the bot's computer", () => {
    expect([
      describeBoxHandoff({
        requestId: "h-1",
        instruction: " Sign in to Xero ",
      }),
      describeBoxHandoff({ requestId: "h-2", instruction: "" }),
    ]).toEqual([
      "Take over the bot's computer: Sign in to Xero",
      "Take over the bot's computer",
    ]);
  });
});

describe("card text never shows a site's path or query", () => {
  it("keeps only the host of a site without a scheme", () => {
    const { text } = describeCard("credential-request", {
      credentialRequest: {
        kind: "brokered-login",
        goal: "Sign in to the store",
        entries: [{ website: "shop.example.com/login?session=abc123" }],
      },
    });
    expect([
      text.includes("shop.example.com"),
      text.includes("abc123"),
    ]).toEqual([true, false]);
  });
});
