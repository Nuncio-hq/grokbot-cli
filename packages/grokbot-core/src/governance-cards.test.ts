import { describe, expect, it } from "vitest";
import type { Agent, AgentId } from "./agents.js";
import { GrokBotError } from "./contracts.js";
import { sendMessageRow, textReplyRow } from "./fixtures/wire-entries.js";
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

  it("returns no cards for a missing entries list", () => {
    expect([openCards(undefined), openCards([widget(1)]).length]).toEqual([
      [],
      1,
    ]);
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
