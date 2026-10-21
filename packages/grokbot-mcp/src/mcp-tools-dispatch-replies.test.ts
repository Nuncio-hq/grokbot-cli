import { Buffer } from "node:buffer";
import { parseTranscriptEntries } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY_TEST } from "./fixtures/mcp-session.js";
import { summarize } from "./tool-summaries.js";

const MAPS_URL = "https://maps.example/p/1";
const FILE_URL = "https://files.example/r.pdf?sig=secret";

const row = (seq: number, message: Record<string, unknown>) => ({
  seq: String(seq),
  entryId: `e${seq}`,
  entryKind: "send-message",
  body: Buffer.from(JSON.stringify({ kind: "send-message", message })).toString(
    "base64",
  ),
});

describe("tail summary for visuals and cards", () => {
  const entries = parseTranscriptEntries([
    row(1, {
      type: "visualization",
      title: "Sales by region",
      documentSha256: "ab".repeat(32),
      heightPx: 320,
    }),
    row(2, {
      type: "text",
      content: "Two spots nearby",
      cards: {
        start: 0,
        items: [
          {
            card: {
              kind: "places",
              places: [
                { id: "1", name: "A", mapsUrl: MAPS_URL },
                { id: "2", name: "B" },
              ],
            },
          },
        ],
      },
    }),
    row(3, { type: "attachment", url: FILE_URL, file_name: "r.pdf" }),
    row(4, { type: "text", content: "Plain" }),
  ]);
  const text = summarize("tail", { agent: PRIMARY_TEST, entries });

  it("shows a visual like an attachment and counts the entries of a card", () => {
    expect(text.split("\n").slice(1)).toEqual([
      "#1 [e1] reply: Sales by region [visual]",
      "#2 [e2] reply: Two spots nearby [2 places]",
      "#3 [e3] reply: r.pdf [attachment]",
      "#4 [e4] reply: Plain",
    ]);
  });

  it("never carries an attachment, map or product link", () => {
    expect(text).not.toContain(FILE_URL);
    expect(text).not.toContain(MAPS_URL);
  });
});
