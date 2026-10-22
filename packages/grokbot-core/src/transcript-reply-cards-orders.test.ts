import { describe, expect, it } from "vitest";
import { sendMessageRow } from "./fixtures/wire-entries.js";
import { parseTranscriptEntry } from "./transcript.js";

/** The cards a text reply carries, as `parseTranscriptEntry` keeps them. */
const cardsOf = (...cards: unknown[]) => {
  const entry = parseTranscriptEntry(
    sendMessageRow(5, {
      type: "text",
      content: "Here you go",
      cards: { start: 0, items: cards.map((card) => ({ card })) },
    }),
  );
  return entry.kind === "reply" && entry.reply.type === "text"
    ? entry.reply.cards
    : undefined;
};

const weather = (fields: Record<string, unknown> = {}) => ({
  kind: "weather",
  weather: {
    locationLabel: "Berlin",
    locationQuery: "Berlin, Germany",
    timeZone: "Europe/Berlin",
    temperatureScale: "celsius",
    focus: "none",
    asOfMs: 1,
    attributionUrl: "https://weather.example/legal",
    current: {
      conditionCode: "clear",
      daylight: true,
      temperatureC: 18.4,
      apparentC: 17,
      humidity: 0.5,
      uvIndex: 3,
      windKph: 12,
    },
    days: [{ startMs: 1, conditionCode: "clear", maxC: 20, minC: 10 }],
    hours: [],
    ...fields,
  },
});

const shipment = (fields: Record<string, unknown> = {}) => ({
  kind: "shipment",
  v: 1,
  site: "shop.example",
  merchant: { name: "Example Shop", url: "https://shop.example" },
  orderNumber: "EX-1001",
  stage: "in_transit",
  status: "Out for delivery soon",
  expectedDeliveryDate: "2026-10-25",
  items: [
    { title: "Kettle", quantity: 2, imageUrl: "https://img.example/k.png" },
    { title: "Filter" },
  ],
  tracking: { url: "https://track.example/EX-1001", carrier: "UPS" },
  sentAtMs: 1,
  ...fields,
});

const purchase = (fields: Record<string, unknown> = {}) => ({
  kind: "purchase",
  v: 1,
  orderId: "order-1",
  outcome: "placed",
  orderNumber: "EX-1001",
  chargedAtMs: 1,
  ...fields,
});

describe("weather cards", () => {
  it("keeps the place, the current temperature and the attribution link", () => {
    expect(cardsOf(weather())).toEqual([
      {
        kind: "weather",
        locationLabel: "Berlin",
        temperatureScale: "celsius",
        conditionCode: "clear",
        temperatureC: 18.4,
        attributionUrl: "https://weather.example/legal",
      },
    ]);
  });

  it("needs only a location label", () => {
    expect(
      cardsOf({ kind: "weather", weather: { locationLabel: "Berlin" } }),
    ).toEqual([{ kind: "weather", locationLabel: "Berlin" }]);
  });

  it("drops a field of the wrong type and keeps the card", () => {
    const [card] =
      cardsOf(
        weather({
          temperatureScale: "kelvin",
          attributionUrl: "http://insecure.example/legal",
          current: { conditionCode: 4, temperatureC: "warm" },
        }),
      ) ?? [];
    expect(card).toEqual({ kind: "weather", locationLabel: "Berlin" });
  });

  it.each([
    ["has no weather object", { kind: "weather" }],
    ["has a weather that is a list", { kind: "weather", weather: [] }],
    ["has a label that is not text", weather({ locationLabel: 7 })],
    ["has a blank label", weather({ locationLabel: "  " })],
  ])("skips a card that %s", (_name, card) => {
    expect(cardsOf(card)).toBeUndefined();
  });
});

describe("shipment cards", () => {
  it("keeps the order, its stage, items and tracking", () => {
    expect(cardsOf(shipment())).toEqual([
      {
        kind: "shipment",
        merchant: "Example Shop",
        orderNumber: "EX-1001",
        stage: "in_transit",
        status: "Out for delivery soon",
        expectedDeliveryDate: "2026-10-25",
        items: [{ title: "Kettle", quantity: 2 }, { title: "Filter" }],
        tracking: { url: "https://track.example/EX-1001", carrier: "UPS" },
      },
    ]);
  });

  it("needs only a merchant name, an order number and a stage", () => {
    expect(
      cardsOf({
        kind: "shipment",
        v: 1,
        merchant: { name: "Example Shop" },
        orderNumber: "EX-1001",
        stage: "placed",
      }),
    ).toEqual([
      {
        kind: "shipment",
        merchant: "Example Shop",
        orderNumber: "EX-1001",
        stage: "placed",
      },
    ]);
  });

  it("drops a field of the wrong type and keeps the card", () => {
    const [card] =
      cardsOf(
        shipment({
          status: 5,
          expectedDeliveryDate: "2026-02-30",
          items: [
            { title: "Kettle", quantity: 1.5 },
            { quantity: 2 },
            "Filter",
            { title: "Bulb", quantity: "2" },
          ],
          tracking: { url: "http://track.example/EX-1001", carrier: "UPS" },
        }),
      ) ?? [];
    expect(card).toEqual({
      kind: "shipment",
      merchant: "Example Shop",
      orderNumber: "EX-1001",
      stage: "in_transit",
      items: [{ title: "Kettle" }, { title: "Bulb" }],
    });
  });

  it("drops a carrier that has no link to go with it", () => {
    const [card] =
      cardsOf(shipment({ tracking: { carrier: "UPS" }, items: "Kettle" })) ??
      [];
    expect(card).not.toHaveProperty("tracking");
    expect(card).not.toHaveProperty("items");
  });

  it.each([
    "placed",
    "in_transit",
    "arriving_today",
    "delivered",
    "delayed",
    "cancelled",
  ])("accepts the stage %s", (stage) => {
    expect(cardsOf(shipment({ stage }))?.[0]).toMatchObject({
      kind: "shipment",
      stage,
    });
  });

  it.each([
    ["has no version", { v: undefined }],
    ["has a version below 1", { v: 0 }],
    ["has a version that is not a number", { v: "1" }],
    ["has an unknown stage", { stage: "lost" }],
    ["has no stage", { stage: undefined }],
    ["has an order number that is not text", { orderNumber: 1001 }],
    ["has a blank order number", { orderNumber: " " }],
    ["has a merchant that is not an object", { merchant: "Example Shop" }],
    [
      "has a merchant without a name",
      { merchant: { url: "https://a.example" } },
    ],
  ])("skips a card that %s", (_name, fields) => {
    expect(cardsOf(shipment(fields))).toBeUndefined();
  });

  it("reads a later version the same way", () => {
    expect(cardsOf(shipment({ v: 2 }))?.[0]).toMatchObject({
      kind: "shipment",
      orderNumber: "EX-1001",
    });
  });
});

describe("purchase cards", () => {
  it("keeps the order, its outcome and the order number", () => {
    expect(cardsOf(purchase())).toEqual([
      {
        kind: "purchase",
        orderId: "order-1",
        outcome: "placed",
        orderNumber: "EX-1001",
      },
    ]);
  });

  it("keeps the reason of a failed purchase", () => {
    expect(
      cardsOf(
        purchase({
          outcome: "failed",
          orderNumber: undefined,
          reason: "Card declined",
        }),
      ),
    ).toEqual([
      {
        kind: "purchase",
        orderId: "order-1",
        outcome: "failed",
        reason: "Card declined",
      },
    ]);
  });

  it("needs only an order id and an outcome", () => {
    expect(
      cardsOf({
        kind: "purchase",
        v: 1,
        orderId: "order-1",
        outcome: "failed",
      }),
    ).toEqual([{ kind: "purchase", orderId: "order-1", outcome: "failed" }]);
  });

  it("drops a field of the wrong type and keeps the card", () => {
    expect(
      cardsOf(purchase({ orderNumber: 1001, reason: { text: "no" } })),
    ).toEqual([{ kind: "purchase", orderId: "order-1", outcome: "placed" }]);
  });

  it.each([
    ["has no version", { v: undefined }],
    ["has a version below 1", { v: 0 }],
    ["has no order id", { orderId: undefined }],
    ["has an empty order id", { orderId: "" }],
    ["has an order id that is not text", { orderId: 1 }],
    ["has an unknown outcome", { outcome: "pending" }],
    ["has no outcome", { outcome: undefined }],
  ])("skips a card that %s", (_name, fields) => {
    expect(cardsOf(purchase(fields))).toBeUndefined();
  });
});

describe("weather, shipment and purchase cards among others", () => {
  it("keeps the good cards in order and skips an unknown kind and a broken card", () => {
    const cards = cardsOf(
      weather(),
      { kind: "rule-change", ruleId: "r-1" },
      shipment({ stage: "lost" }),
      { kind: "places", places: [{ name: "Example Cafe" }] },
      purchase(),
      null,
      "card",
    );
    expect(cards?.map((card) => card.kind)).toEqual([
      "weather",
      "places",
      "purchase",
    ]);
  });

  it("keeps the text row whatever the cards hold", () => {
    const entry = parseTranscriptEntry(
      sendMessageRow(5, {
        type: "text",
        content: "Hi",
        cards: {
          items: [
            { card: weather({ locationLabel: 1 }) },
            { card: shipment({ v: 0 }) },
          ],
        },
      }),
    );
    expect(entry.kind === "reply" && entry.reply).toEqual({
      type: "text",
      content: "Hi",
    });
  });
});
