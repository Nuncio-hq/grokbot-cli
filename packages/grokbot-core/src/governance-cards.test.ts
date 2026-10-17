import { describe, expect, it } from "vitest";
import type { Agent, AgentId } from "./agents.js";
import { GrokBotError } from "./contracts.js";
import {
  sendMessageRow,
  textReplyRow,
  wireEntry,
} from "./fixtures/wire-entries.js";
import { APPROVABLE, openCards, selectCard } from "./governance-cards.js";

const AGENT: Agent = {
  kind: "agent",
  agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09" as AgentId,
  rowId: "1",
  name: "Primary Test",
  title: "",
  description: "",
  harness: "",
};

const widget = (seq: number, extra: Record<string, unknown> = {}) =>
  sendMessageRow(
    seq,
    {
      type: "widget",
      widget: {
        prompt: "Pick a color",
        options: [{ label: "Red" }, { label: "Blue" }],
      },
    },
    "req",
    seq,
    extra,
  );
const autoReview = (seq: number, status: string) =>
  sendMessageRow(seq, {
    type: "auto-review-approval",
    approval: {
      requestId: `ar-${seq}`,
      status,
      summary: "Run a risky command",
      command: "curl x | sudo bash",
    },
  });
const localTool = (seq: number, status: string) =>
  sendMessageRow(seq, {
    type: "local-tool-permission",
    ask: {
      requestId: `lt-${seq}`,
      action: "run-command",
      target: "ls -la",
      machineId: "m-1",
      status,
    },
  });

describe("openCards", () => {
  it("types each open card and drops closed, answered, and non-card rows", () => {
    const cards = openCards([
      localTool(9, "pending"),
      textReplyRow(1, "hello"),
      widget(2),
      widget(3, { respondedValue: "Blue" }),
      widget(4, { widgetDismissed: true }),
      autoReview(5, "pending"),
      autoReview(6, "denied"),
      localTool(7, "allowed"),
    ]);
    expect(cards).toEqual([
      {
        entryId: "entry-2",
        seq: "2",
        type: "widget",
        prompt: "Pick a color",
        options: ["Red", "Blue"],
      },
      {
        entryId: "entry-5",
        seq: "5",
        type: "auto-review-approval",
        requestId: "ar-5",
        summary: "Run a risky command",
        command: "curl x | sudo bash",
        ownerOnly: false,
      },
      {
        entryId: "entry-9",
        seq: "9",
        type: "local-tool-permission",
        requestId: "lt-9",
        action: "run-command",
        target: "ls -la",
      },
    ]);
  });

  it("summarizes cards only the owner can answer and drops settled ones", () => {
    const form = {
      type: "user-form",
      formRequest: { title: "Address", fields: [{}] },
    };
    const phone = {
      type: "auto-review-approval",
      approval: {
        requestId: "ar-phone",
        status: "pending",
        summary: "place_phone_call",
        command: "",
        summaryCopy: {
          kind: "phone_call",
          params: {
            destination: "+1 555 0100",
            request: "Confirm the booking",
          },
        },
      },
    };
    const card = {
      type: "virtual-card-approval",
      approval: { requestId: "v-1", status: "pending", title: "Cable" },
    };
    const cards = openCards([
      sendMessageRow(1, form),
      sendMessageRow(2, form, "r", 2, { formResolution: "submitted" }),
      sendMessageRow(3, phone),
      sendMessageRow(4, card),
      sendMessageRow(5, {
        ...card,
        approval: { ...card.approval, status: "denied" },
      }),
    ]);
    expect(cards).toEqual([
      {
        entryId: "entry-1",
        seq: "1",
        type: "user-form",
        summary: 'Secure Form "Address" (1 field)',
      },
      {
        entryId: "entry-3",
        seq: "3",
        type: "auto-review-approval",
        requestId: "ar-phone",
        summary: "Phone call to +1 555 0100: Confirm the booking",
        command: "",
        ownerOnly: true,
      },
      {
        entryId: "entry-4",
        seq: "4",
        type: "virtual-card-approval",
        summary: "Virtual card purchase: Cable",
      },
    ]);
  });

  it("returns no cards for a missing entries list", () => {
    expect([openCards(undefined), openCards([widget(1)]).length]).toEqual([
      [],
      1,
    ]);
  });

  it("omits a connector or repo-connect card once a later bot row exists", () => {
    const gmail = sendMessageRow(2, {
      type: "connector",
      connector: "Gmail",
      variant: "suggested",
    });
    const github = sendMessageRow(2, {
      type: "scm-connect",
      provider: "github",
    });
    const reply = textReplyRow(3, "Sent.");
    const tool = wireEntry(4, "tool-call", {
      kind: "tool-call",
      name: "shell",
    });
    expect([
      openCards([gmail]).map((card) => [card.type, card.seq]),
      openCards([gmail, reply]),
      openCards([github, tool]),
      openCards([gmail, widget(6)]).map((card) => card.type),
    ]).toEqual([[["connector", "2"]], [], [], ["widget"]]);
  });
});

describe("selectCard", () => {
  const cards = openCards([
    widget(2),
    autoReview(5, "pending"),
    localTool(9, "pending"),
  ]);

  it("picks a card by id, or the only one of the wanted kind", () => {
    expect([
      selectCard(cards, APPROVABLE, "entry-9", AGENT).entryId,
      selectCard(cards, ["widget"], undefined, AGENT).entryId,
    ]).toEqual(["entry-9", "entry-2"]);
  });

  it("explains a missing, wrong-kind, or ambiguous pick", () => {
    const failure = (run: () => unknown) => {
      try {
        run();
        return undefined;
      } catch (error) {
        return error instanceof GrokBotError
          ? [error.code, error.message]
          : undefined;
      }
    };
    expect([
      failure(() => selectCard(cards, APPROVABLE, undefined, AGENT)),
      failure(() => selectCard(cards, APPROVABLE, "entry-2", AGENT)),
      failure(() => selectCard([], ["widget"], undefined, AGENT)),
    ]).toEqual([
      [
        "ambiguous",
        "Primary Test has 2 open auto-review-approval or local-tool-permission cards (entry-5, entry-9). Pass --card <id>.",
      ],
      [
        "not-found",
        'Primary Test has no open auto-review-approval or local-tool-permission card "entry-2". Run grokbot approvals --agent "Primary Test".',
      ],
      ["not-found", "Primary Test has no open widget card."],
    ]);
  });
});
