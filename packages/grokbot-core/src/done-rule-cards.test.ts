import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type LiveStatus } from "./agent-status.js";
import {
  BLUE_MESSAGE_ID as BLUE,
  COLOR_WIDGET,
  DISMISSED_TRACE as DISMISSED,
  GREEN_MESSAGE_ID as GREEN,
  SECRET_TRACE as SECRET,
  SECRET_MESSAGE_ID,
  SIZE_MESSAGE_ID,
  WIDGET_TRACE as W,
} from "./fixtures/card-traces.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  sendMessageRow,
  textReplyRow,
  withEntryId,
} from "./fixtures/wire-entries.js";

const RUNNING: LiveStatus = { ...IDLE_STATUS, isRunning: true };

describe("Done Rule on the 15 Oct question widget (#141 to #150)", () => {
  it("awaits the owner on the open widget although live.awaiting is unset", () => {
    const v = verdict([W.blueEcho, W.blueCard], IDLE_STATUS, BLUE);
    expect(
      v.status === "awaiting-approval" && [
        v.reason,
        v.cards.map((c) => [c.seq, c.cardType]),
      ],
    ).toEqual(["Which color do you pick?", [["142", "widget"]]]);
  });

  it("keeps running while the bot still works after showing the widget", () => {
    expect(summary([W.blueEcho, W.blueCard], RUNNING, BLUE)).toBe(
      "running:target-active",
    );
  });

  it("waits for the bot once the widget is answered, never taking a note from before the widget", () => {
    const intro = textReplyRow(142, "Here is your question.", "0a80c5a7");
    const answered = withEntryId(
      sendMessageRow(143, COLOR_WIDGET, "0a80c5a7", 145, {
        respondedValue: "Blue",
      }),
      "t51s1",
    );
    expect([
      summary([W.blueEcho, W.blueAnswered], IDLE_STATUS, BLUE),
      summary([W.blueEcho, intro, answered], IDLE_STATUS, BLUE),
    ]).toEqual([
      "running:awaiting-final-reply",
      "running:awaiting-final-reply",
    ]);
  });

  it("is done with the reply the bot posts in a new run after the answer", () => {
    const rows = [W.blueEcho, W.blueAnswered, W.blueReply];
    const v = verdict(rows, IDLE_STATUS, BLUE);
    expect(
      v.status === "done" && [
        v.finalReply,
        v.replies.map((r) => [r.seq, r.requestId]),
      ],
    ).toEqual(["You picked Blue.", [["144", "286281d4"]]]);
  });

  it("lets the reply run end the turn even before the answered card version arrives", () => {
    const rows = [W.blueEcho, W.blueCard, W.blueReply];
    expect(summary(rows, IDLE_STATUS, BLUE)).toBe("done:You picked Blue.");
  });

  /** Live, the green ask went out after Blue's reply, with the bot idle. */
  const greenSentIdle = new Map([[GREEN, false]]);

  it("keeps the next turn's widget and its reply out of a finished turn", () => {
    const next = [
      W.blueEcho,
      W.blueAnswered,
      W.blueReply,
      W.greenEcho,
      W.greenCard,
    ];
    expect([
      summary(next, IDLE_STATUS, BLUE, greenSentIdle),
      summary(next, IDLE_STATUS, GREEN, greenSentIdle),
    ]).toEqual(["done:You picked Blue.", "awaiting-approval:147"]);
    const all = [...next, W.greenAnswered, W.greenReply];
    expect([
      summary(all, IDLE_STATUS, BLUE, greenSentIdle),
      summary(all, IDLE_STATUS, GREEN, greenSentIdle),
    ]).toEqual(["done:You picked Blue.", "done:You picked Green."]);
  });

  it("never ends Blue done with Green's reply when nothing recorded how Green was sent", () => {
    const all = [
      W.blueEcho,
      W.blueAnswered,
      W.blueReply,
      W.greenEcho,
      W.greenAnswered,
      W.greenReply,
    ];
    expect(summary(all, IDLE_STATUS, BLUE)).toBe(
      "ambiguous:You picked Blue.\n\nYou picked Green.",
    );
  });

  it("keeps the Fix A guard: the next turn's live.awaiting holds a finished turn running, never awaiting", () => {
    const rows = [
      W.blueEcho,
      W.blueAnswered,
      W.blueReply,
      W.greenEcho,
      W.greenCard,
    ];
    const awaiting = { ...IDLE_STATUS, awaiting: { reason: "Pick a color" } };
    expect([
      summary(rows, awaiting, BLUE, greenSentIdle),
      summary(rows, awaiting, GREEN, greenSentIdle),
    ]).toEqual(["running:target-active", "awaiting-approval:147"]);
  });
});

describe("Done Rule on a dismissed widget (14 Oct #10 to #14, reply synthesized)", () => {
  const { echo, dismissed, reply } = DISMISSED;

  it("treats the dismissed widget as closed and waits for the bot", () => {
    expect(summary([echo, dismissed], IDLE_STATUS, SIZE_MESSAGE_ID)).toBe(
      "running:awaiting-final-reply",
    );
  });

  it("is done with the reply the bot posts in a new run after the dismissal", () => {
    expect(
      summary([echo, dismissed, reply], IDLE_STATUS, SIZE_MESSAGE_ID),
    ).toBe("done:OK, I'll pick Small for you.");
  });
});

describe("Done Rule on a secret request card (14 Oct #13 to #18)", () => {
  const { echo, card, provided, reply } = SECRET;

  it("awaits the owner on the open card, named by what it asks", () => {
    const v = verdict([echo, card], IDLE_STATUS, SECRET_MESSAGE_ID);
    expect(
      v.status === "awaiting-approval" && [v.reason, v.cards.map((c) => c.seq)],
    ).toEqual(["Secret requested: Dummy test token", ["15"]]);
  });

  it("is done with the new-run reply once the secret is provided", () => {
    expect(
      summary([echo, provided, reply], IDLE_STATUS, SECRET_MESSAGE_ID),
    ).toBe(
      "done:Got it. `TEST_DUMMY_TOKEN` is set, and it's 11 characters long.",
    );
  });
});
