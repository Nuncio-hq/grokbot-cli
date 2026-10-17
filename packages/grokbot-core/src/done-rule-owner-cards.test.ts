import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  sendMessageRow,
  textReplyRow,
  userRow,
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

  it("holds our message when a hand-off raised before it is still pending", () => {
    expect(summary([echo, laterOwner], handingOff, ID)).toBe(
      "awaiting-approval:",
    );
  });

  it("settles our answered turn when the owner wrote to an idle bot after it, since the hand-off is not ours", () => {
    const laterSentIdle = new Map([["m-later", false]]);
    expect([
      summary([echo, askHelp, laterOwner], handingOff, ID, laterSentIdle),
      summary([echo, askHelp, laterOwner], handingOff, ID),
    ]).toEqual(["done:Please sign in on my computer.", "awaiting-approval:"]);
  });
});
