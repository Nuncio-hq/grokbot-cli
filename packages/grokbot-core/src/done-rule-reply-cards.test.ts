import { describe, expect, it } from "vitest";
import { IDLE_STATUS } from "./agent-status.js";
import { summary, verdict } from "./fixtures/done-rule-summary.js";
import {
  sendMessageRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";

const echo = userRow(10, "What is the weather in Berlin?", {
  clientNonce: "m-1",
});
const WEATHER = {
  kind: "weather",
  weather: {
    locationLabel: "Berlin",
    temperatureScale: "celsius",
    attributionUrl: "https://weather.example/legal",
    current: { conditionCode: "clear", temperatureC: 18.4 },
  },
};
const PURCHASE = {
  kind: "purchase",
  v: 1,
  orderId: "order-1",
  outcome: "failed",
  reason: "Card declined",
};
const withCards = (seq: number, content: string, ...cards: unknown[]) =>
  sendMessageRow(seq, {
    type: "text",
    content,
    cards: { start: 0, items: cards.map((card) => ({ card })) },
  });

describe("Done Rule on a text reply that carries cards", () => {
  it("ends a turn whose only answer is cards on an empty text with their tags", () => {
    expect(summary([echo, withCards(11, "", WEATHER)], IDLE_STATUS)).toBe(
      "done:[weather: Berlin, 18 °C]",
    );
  });

  it("tells every card of the answer, never a link", () => {
    const v = verdict(
      [echo, withCards(11, "  ", WEATHER, PURCHASE)],
      IDLE_STATUS,
    );
    expect(v.status === "done" && v.finalReply).toBe(
      "[weather: Berlin, 18 °C] [purchase: failed: Card declined]",
    );
    expect(v.status === "done" && v.finalReply).not.toContain("https");
  });

  it("keeps the text of a reply that has some", () => {
    expect(
      summary([echo, withCards(11, "It is mild.", WEATHER)], IDLE_STATUS),
    ).toBe("done:It is mild.");
  });

  it("leaves an empty text with no card that parses as it was", () => {
    expect(
      summary([echo, withCards(11, "", { kind: "weather" })], IDLE_STATUS),
    ).toBe("done:");
    expect(summary([echo, textReplyRow(11, "")], IDLE_STATUS)).toBe("done:");
  });

  it("keeps the replies of the verdict with their cards", () => {
    const v = verdict([echo, withCards(11, "", WEATHER)], IDLE_STATUS);
    expect(
      v.status === "done" &&
        v.replies.map((r) => r.reply.type === "text" && r.reply.cards),
    ).toEqual([
      [
        {
          kind: "weather",
          locationLabel: "Berlin",
          temperatureScale: "celsius",
          conditionCode: "clear",
          temperatureC: 18.4,
          attributionUrl: "https://weather.example/legal",
        },
      ],
    ]);
  });
});
