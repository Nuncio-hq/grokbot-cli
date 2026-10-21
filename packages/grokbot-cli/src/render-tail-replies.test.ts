import { describe, expect, it } from "vitest";
import { entries, PRIMARY, row } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const send = (message: Record<string, unknown>) => ({
  kind: "send-message",
  message,
});

const MAPS_URL = "https://maps.example/p/1";
const SHOP_URL = "https://shop.example/kettle";
const FILE_URL = "https://files.example/r.pdf?sig=secret";

const tail = entries([
  row(
    1,
    "send-message",
    send({
      type: "visualization",
      title: "Sales by region",
      documentSha256: "ab".repeat(32),
      heightPx: 320,
    }),
  ),
  row(
    2,
    "send-message",
    send({
      type: "text",
      content: "Three spots nearby",
      cards: {
        start: 0,
        items: [
          {
            card: {
              kind: "places",
              places: [
                { id: "1", name: "A", mapsUrl: MAPS_URL },
                { id: "2", name: "B" },
                { id: "3", name: "C" },
              ],
            },
          },
        ],
      },
    }),
  ),
  row(
    3,
    "send-message",
    send({
      type: "text",
      content: "One kettle",
      cards: {
        start: 0,
        items: [
          {
            card: {
              kind: "shopping",
              v: 2,
              products: [
                {
                  title: "Kettle",
                  variants: [
                    {
                      options: {},
                      offers: [
                        {
                          seller: "Example Shop",
                          url: SHOP_URL,
                          price: { amount: 19.5, currency: "EUR" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    }),
  ),
  row(
    4,
    "send-message",
    send({ type: "attachment", url: FILE_URL, file_name: "r.pdf" }),
  ),
  row(5, "send-message", send({ type: "text", content: "Plain" })),
]);

describe("tail shows visuals and cards", () => {
  it("shows a visual like an attachment and counts the entries of a card", async () => {
    const run = await runCli(["tail"], {
      outputs: { tail: { agent: PRIMARY, entries: tail } },
    });
    expect(run.stdout).toBe(
      [
        "[1 e1] reply: Sales by region [visual]",
        "[2 e2] reply: Three spots nearby [3 places]",
        "[3 e3] reply: One kettle [1 product]",
        "[4 e4] reply: r.pdf [attachment]",
        "[5 e5] reply: Plain",
        "",
      ].join("\n"),
    );
  });

  it("never prints an attachment link or a map or product link in human mode", async () => {
    const run = await runCli(["tail"], {
      outputs: { tail: { agent: PRIMARY, entries: tail } },
    });
    for (const link of [FILE_URL, MAPS_URL, SHOP_URL])
      expect(run.stdout + run.stderr).not.toContain(link);
  });

  it("carries the parsed replies and their cards in --json", async () => {
    const run = await runCli(["tail", "--json"], {
      outputs: { tail: { agent: PRIMARY, entries: tail } },
    });
    const replies = JSON.parse(run.stdout).entries.map(
      (e: { reply: unknown }) => e.reply,
    );
    expect(replies.slice(0, 3)).toEqual([
      {
        type: "visualization",
        title: "Sales by region",
        documentSha256: "ab".repeat(32),
      },
      {
        type: "text",
        content: "Three spots nearby",
        cards: [
          {
            kind: "places",
            places: [
              { name: "A", mapsUrl: MAPS_URL },
              { name: "B" },
              { name: "C" },
            ],
          },
        ],
      },
      {
        type: "text",
        content: "One kettle",
        cards: [
          {
            kind: "shopping",
            products: [
              {
                name: "Kettle",
                price: { amount: 19.5, currency: "EUR" },
                merchant: "Example Shop",
                url: SHOP_URL,
              },
            ],
          },
        ],
      },
    ]);
  });
});
