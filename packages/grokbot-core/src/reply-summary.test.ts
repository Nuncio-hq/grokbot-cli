import { describe, expect, it } from "vitest";
import type { ReplyCard, ShipmentStage } from "./reply-cards.js";
import { describeReply } from "./reply-summary.js";
import type { Reply } from "./transcript.js";

const text = (content: string, ...cards: ReplyCard[]): Reply => ({
  type: "text",
  content,
  ...(cards.length > 0 && { cards }),
});

const weather = (fields: Partial<ReplyCard & { kind: "weather" }> = {}) =>
  ({
    kind: "weather",
    locationLabel: "Berlin",
    temperatureScale: "celsius",
    temperatureC: 18.4,
    ...fields,
  }) as ReplyCard;

const shipment = (stage: ShipmentStage = "in_transit") =>
  ({
    kind: "shipment",
    merchant: "Example Shop",
    orderNumber: "EX-1001",
    stage,
  }) as ReplyCard;

const purchase = (fields: Partial<ReplyCard & { kind: "purchase" }> = {}) =>
  ({
    kind: "purchase",
    orderId: "order-1",
    outcome: "placed",
    ...fields,
  }) as ReplyCard;

describe("describeReply on weather cards", () => {
  it("names the place and the current temperature in Celsius", () => {
    expect(describeReply(text("Here you go", weather()))).toBe(
      "Here you go [weather: Berlin, 18 °C]",
    );
  });

  it("converts to Fahrenheit when the card shows that scale", () => {
    expect(
      describeReply(
        text("", weather({ temperatureScale: "fahrenheit", temperatureC: 18 })),
      ),
    ).toBe("[weather: Berlin, 64 °F]");
  });

  it("reads a card without a scale as Celsius", () => {
    expect(
      describeReply(text("", weather({ temperatureScale: undefined }))),
    ).toBe("[weather: Berlin, 18 °C]");
  });

  it("never shows a minus sign on zero", () => {
    expect(describeReply(text("", weather({ temperatureC: -0.2 })))).toBe(
      "[weather: Berlin, 0 °C]",
    );
  });

  it("names only the place when the card has no temperature", () => {
    expect(describeReply(text("", weather({ temperatureC: undefined })))).toBe(
      "[weather: Berlin]",
    );
  });

  it("keeps the place on one line", () => {
    expect(
      describeReply(text("", weather({ locationLabel: "Berlin,\n  Germany" }))),
    ).toBe("[weather: Berlin, Germany, 18 °C]");
  });
});

describe("describeReply on shipment cards", () => {
  it.each([
    ["placed", "placed"],
    ["in_transit", "in transit"],
    ["arriving_today", "arriving today"],
    ["delivered", "delivered"],
    ["delayed", "delayed"],
    ["cancelled", "cancelled"],
  ] as const)("words the stage %s as %s", (stage, words) => {
    expect(describeReply(text("Update", shipment(stage)))).toBe(
      `Update [shipment: Example Shop order EX-1001, ${words}]`,
    );
  });
});

describe("describeReply on purchase cards", () => {
  it("names the order number of a placed purchase", () => {
    expect(describeReply(text("", purchase({ orderNumber: "EX-1001" })))).toBe(
      "[purchase: placed, order EX-1001]",
    );
  });

  it("says only placed when the order has no number yet", () => {
    expect(describeReply(text("Bought", purchase()))).toBe(
      "Bought [purchase: placed]",
    );
  });

  it("gives the reason of a failed purchase", () => {
    expect(
      describeReply(
        text("", purchase({ outcome: "failed", reason: "Card declined" })),
      ),
    ).toBe("[purchase: failed: Card declined]");
  });

  it("says only failed when there is no reason, and ignores a number it has", () => {
    expect(
      describeReply(
        text("", purchase({ outcome: "failed", orderNumber: "EX-1001" })),
      ),
    ).toBe("[purchase: failed]");
  });

  it("keeps a reason on one line", () => {
    expect(
      describeReply(
        text(
          "",
          purchase({ outcome: "failed", reason: "Card\ndeclined\n\nby bank" }),
        ),
      ),
    ).toBe("[purchase: failed: Card declined by bank]");
  });
});

describe("describeReply on several cards", () => {
  it("counts places and products in one tag and gives each other card its own", () => {
    expect(
      describeReply(
        text(
          "Mixed",
          { kind: "places", places: [{ name: "A" }, { name: "B" }] },
          weather(),
          { kind: "shopping", products: [{ name: "Kettle" }] },
          shipment(),
        ),
      ),
    ).toBe(
      "Mixed [2 places, 1 product] [weather: Berlin, 18 °C] [shipment: Example Shop order EX-1001, in transit]",
    );
  });

  it("leaves the count of places and products as it was", () => {
    expect(
      describeReply(
        text("Three spots nearby", {
          kind: "places",
          places: [{ name: "A" }, { name: "B" }, { name: "C" }],
        }),
      ),
    ).toBe("Three spots nearby [3 places]");
  });

  it("shows the tags of the cards in the order of the cards", () => {
    expect(describeReply(text("", purchase(), weather()))).toBe(
      "[purchase: placed] [weather: Berlin, 18 °C]",
    );
  });
});

describe("describeReply never shows a link", () => {
  it("leaves out the attribution and tracking links, in the text and in the tags", () => {
    const summary = describeReply(
      text(
        "Update",
        {
          ...weather(),
          attributionUrl: "https://weather.example/legal",
        } as ReplyCard,
        {
          ...shipment(),
          tracking: { url: "https://track.example/EX-1001?sig=secret" },
        } as ReplyCard,
      ),
    );
    expect(summary).not.toContain("weather.example");
    expect(summary).not.toContain("track.example");
    expect(summary).not.toContain("secret");
  });
});
