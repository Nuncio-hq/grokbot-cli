import { describe, expect, it } from "vitest";
import { sendMessageRow } from "./fixtures/wire-entries.js";
import { parseTranscriptEntry } from "./transcript.js";

const replyOf = (message: Record<string, unknown>) => {
  const entry = parseTranscriptEntry(sendMessageRow(5, message));
  return entry.kind === "reply" ? entry.reply : undefined;
};

const place = {
  id: "place-1",
  name: "Example Cafe",
  address: "1 Example Street",
  rating: 4.6,
  ratingCount: 120,
  mapsUrl: "https://maps.example/p/1",
  openingHours: { weekdayDescriptions: ["Mon: 9-17"] },
  location: { latitude: 1, longitude: 2 },
  photos: [],
};

const product = {
  title: "Example Kettle",
  images: [],
  variants: [
    {
      options: {},
      offers: [
        {
          seller: "Example Shop",
          url: "https://shop.example/kettle",
          price: { amount: 19.5, currency: "EUR" },
          listPrice: { amount: 29, currency: "EUR" },
        },
      ],
    },
  ],
};

describe("visualization replies", () => {
  it("parses the title and document hash and drops the height", () => {
    expect(
      replyOf({
        type: "visualization",
        title: "Sales by region",
        documentSha256: "ab".repeat(32),
        heightPx: 320,
      }),
    ).toEqual({
      type: "visualization",
      title: "Sales by region",
      documentSha256: "ab".repeat(32),
    });
  });

  it("is a reply, not an unknown row, even with no fields", () => {
    expect(replyOf({ type: "visualization" })).toEqual({
      type: "visualization",
      title: "",
      documentSha256: "",
    });
  });
});

describe("cards on a text reply", () => {
  it("keeps the text and parses a places card to its small subset", () => {
    expect(
      replyOf({
        type: "text",
        content: "Two spots nearby",
        cards: {
          start: 0,
          items: [{ card: { kind: "places", places: [place] } }],
        },
      }),
    ).toEqual({
      type: "text",
      content: "Two spots nearby",
      cards: [
        {
          kind: "places",
          places: [
            {
              name: "Example Cafe",
              address: "1 Example Street",
              rating: 4.6,
              mapsUrl: "https://maps.example/p/1",
            },
          ],
        },
      ],
    });
  });

  it("parses a shopping card to name, price, merchant and url of the first offer", () => {
    const reply = replyOf({
      type: "text",
      content: "Found one",
      cards: {
        start: 0,
        items: [
          {
            card: {
              kind: "shopping",
              v: 2,
              sentAtMs: 1,
              products: [product],
            },
          },
        ],
      },
    });
    expect(reply).toMatchObject({
      cards: [
        {
          kind: "shopping",
          products: [
            {
              name: "Example Kettle",
              price: { amount: 19.5, currency: "EUR" },
              merchant: "Example Shop",
              url: "https://shop.example/kettle",
            },
          ],
        },
      ],
    });
  });

  it("prefers the selected variant's offer", () => {
    const withSelected = {
      ...product,
      variants: [
        ...product.variants,
        {
          options: {},
          selected: true,
          offers: [
            {
              seller: "Other Shop",
              url: "https://other.example/k",
              price: { amount: 9, currency: "USD" },
            },
          ],
        },
      ],
    };
    const reply = replyOf({
      type: "text",
      content: "",
      cards: {
        start: 0,
        items: [{ card: { kind: "shopping", v: 2, products: [withSelected] } }],
      },
    });
    expect(
      reply?.type === "text" && reply.cards?.[0]?.kind === "shopping"
        ? reply.cards[0].products[0]
        : undefined,
    ).toEqual({
      name: "Example Kettle",
      price: { amount: 9, currency: "USD" },
      merchant: "Other Shop",
      url: "https://other.example/k",
    });
  });

  it("skips unknown kinds and old shopping versions but keeps the good cards", () => {
    const reply = replyOf({
      type: "text",
      content: "Mixed",
      cards: {
        start: 0,
        items: [
          { card: { kind: "weather", days: [] } },
          { card: { kind: "shopping", v: 1, products: [product] } },
          { card: { kind: "places", places: [place] } },
        ],
      },
    });
    expect(
      reply?.type === "text" && reply.cards?.map((card) => card.kind),
    ).toEqual(["places"]);
  });

  it("drops a place or product without a name and a field of the wrong type", () => {
    const reply = replyOf({
      type: "text",
      content: "Messy",
      cards: {
        start: 0,
        items: [
          {
            card: {
              kind: "places",
              places: [
                { id: "x" },
                {
                  name: "Plain Place",
                  rating: 9,
                  mapsUrl: "http://insecure.example",
                },
              ],
            },
          },
        ],
      },
    });
    expect(reply).toMatchObject({
      cards: [{ kind: "places", places: [{ name: "Plain Place" }] }],
    });
    expect(
      reply?.type === "text" && reply.cards?.[0]?.kind === "places"
        ? Object.keys(reply.cards[0].places[0] ?? {})
        : undefined,
    ).toEqual(["name"]);
  });

  it.each([
    ["is not an object", "nope"],
    ["has no items", {}],
    ["has items that are not a list", { items: "x" }],
    [
      "lists no card that parses",
      { items: [{ card: { kind: "weather" } }, 4] },
    ],
  ])("keeps the text row when cards %s", (_name, cards) => {
    expect(replyOf({ type: "text", content: "Hi", cards })).toEqual({
      type: "text",
      content: "Hi",
    });
  });

  it("carries no cards key on a plain text reply", () => {
    expect(replyOf({ type: "text", content: "Hi" })).toEqual({
      type: "text",
      content: "Hi",
    });
  });
});
