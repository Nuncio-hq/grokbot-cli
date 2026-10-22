import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  blobRow,
  sendMessageRow,
  textReplyRow,
  userRow,
  type WireEntry,
  wireEntry,
} from "./fixtures/wire-entries.js";
import {
  CARD_TYPES,
  compareSeq,
  parseEntriesResponse,
  parseSeq,
  parseTranscriptEntries,
  parseTranscriptEntry,
} from "./transcript.js";

describe("parseTranscriptEntry", () => {
  it("parses our echoed user message with its clientNonce", () => {
    const row = userRow(142, "ping", {
      clientNonce: "msg-1",
      requestId: "req-a",
    });
    expect(parseTranscriptEntry(row)).toEqual({
      seq: "142",
      updatedSeq: "142",
      entryId: "entry-142",
      entryKind: "message",
      kind: "user-message",
      content: "ping",
      clientNonce: "msg-1",
      requestId: "req-a",
      timestampMs: 1_791_948_600_142,
    });
  });

  it("parses text and attachment replies", () => {
    expect(
      parseTranscriptEntry(textReplyRow(147, "RESULT: PONG", "req-b")),
    ).toEqual({
      seq: "147",
      updatedSeq: "147",
      entryId: "entry-147",
      entryKind: "send-message",
      kind: "reply",
      requestId: "req-b",
      timestampMs: 1_791_948_600_147,
      reply: { type: "text", content: "RESULT: PONG" },
    });
    const attachment = sendMessageRow(66, {
      type: "attachment",
      url: "https://example.test/a.png",
      file_name: "a.png",
    });
    expect(parseTranscriptEntry(attachment)).toMatchObject({
      kind: "reply",
      reply: {
        type: "attachment",
        url: "https://example.test/a.png",
        fileName: "a.png",
      },
    });
  });

  it("parses every owner-facing card type as a card", () => {
    const parsed = CARD_TYPES.map((type, i) =>
      parseTranscriptEntry(
        sendMessageRow(200 + i, { type, ask: { status: "pending" } }),
      ),
    );
    expect(
      parsed.map((e) => [e.kind, "cardType" in e ? e.cardType : null]),
    ).toEqual([
      ["card", "widget"],
      ["card", "secret-request"],
      ["card", "auto-review-approval"],
      ["card", "local-tool-permission"],
      ["card", "connector"],
      ["card", "scm-connect"],
      ["card", "connector-grant"],
      ["card", "user-form"],
      ["card", "credential-request"],
      ["card", "virtual-card-approval"],
      ["card", "cookie-origin-approval"],
      ["card", "meeting-join-consent"],
      ["card", "mobile-tool-permission"],
      ["card", "appearance-picker"],
      ["card", "email-offer"],
    ]);
  });

  it("closes an appearance picker on its answer and an email offer on its answer or when replaced", () => {
    const picker = { type: "appearance-picker" };
    const offer = { type: "email-offer", email: "bot@example.com" };
    const open = (row: WireEntry) => {
      const e = parseTranscriptEntry(row);
      return e.kind === "card" && e.open;
    };
    expect([
      open(sendMessageRow(1, picker)),
      open(
        sendMessageRow(2, picker, "r", 2, {
          respondedValue: '{"avatarShape":"circle","avatarColor":"blue"}',
        }),
      ),
      open(sendMessageRow(3, offer)),
      open(
        sendMessageRow(4, offer, "r", 4, { respondedValue: "email-offer:use" }),
      ),
      open(sendMessageRow(5, { ...offer, replaced: true })),
      open(sendMessageRow(6, { ...offer, replaced: false })),
    ]).toEqual([true, false, true, false, false, true]);
  });

  it("closes a Secure Form and a credential request only by their settling body fields", () => {
    const form = {
      type: "user-form",
      formRequest: { title: "Address", fields: [] },
    };
    const login = {
      type: "credential-request",
      credentialRequest: { kind: "vault-login" },
    };
    const open = (row: ReturnType<typeof sendMessageRow>) => {
      const e = parseTranscriptEntry(row);
      return e.kind === "card" && e.open;
    };
    expect([
      open(sendMessageRow(1, form)),
      open(sendMessageRow(2, form, "r", 2, { formResolution: "submitted" })),
      open(sendMessageRow(3, form, "r", 3, { widgetDismissed: true })),
      open(sendMessageRow(4, login)),
      open(
        sendMessageRow(5, login, "r", 5, { credentialResolution: "retryable" }),
      ),
      open(
        sendMessageRow(6, login, "r", 6, { credentialResolution: "filling" }),
      ),
      open(
        sendMessageRow(7, login, "r", 7, { credentialResolution: "approved" }),
      ),
      open(
        sendMessageRow(8, login, "r", 8, { credentialResolution: "denied" }),
      ),
    ]).toEqual([true, false, false, true, true, true, false, false]);
  });

  it("keeps a blob-only row as a placeholder", () => {
    expect(parseTranscriptEntry(blobRow(50, "send-message", "abc123"))).toEqual(
      {
        seq: "50",
        updatedSeq: "50",
        entryId: "entry-50",
        entryKind: "send-message",
        kind: "blob",
        blobHash: "abc123",
      },
    );
  });

  it("keeps new or undecodable kinds as unknown without throwing", () => {
    const newKind = wireEntry(10, "event", { kind: "event", name: "x" });
    const newMessageType = sendMessageRow(11, { type: "poll", options: [] });
    const garbage = {
      seq: "12",
      updatedSeq: "12",
      entryId: "e",
      entryKind: "message",
      body: "%%%",
    };
    expect(
      parseTranscriptEntries([newKind, newMessageType, garbage]).map((e) => [
        e.seq,
        e.kind,
        e.kind === "unknown" ? e.raw : null,
      ]),
    ).toEqual([
      ["10", "unknown", { kind: "event", name: "x" }],
      [
        "11",
        "unknown",
        expect.objectContaining({
          kind: "send-message",
          message: { type: "poll", options: [] },
        }),
      ],
      ["12", "unknown", garbage],
    ]);
  });

  it("rejects a row whose seq is not an int64", () => {
    expect(() =>
      parseTranscriptEntry({ seq: "abc", entryKind: "message" }),
    ).toThrow(GrokBotError);
  });
});

describe("seq ordering", () => {
  it("compares int64 strings numerically, beyond 2^53", () => {
    expect(compareSeq(parseSeq("10"), parseSeq("9"))).toBe(1);
    expect(
      compareSeq(parseSeq("9007199254740993"), parseSeq("9007199254740992")),
    ).toBe(1);
    expect(compareSeq(parseSeq("7"), parseSeq(7))).toBe(0);
    expect(parseSeq(undefined)).toBe("0");
  });

  it("sorts parsed entries by seq, not by string", () => {
    const rows = [
      textReplyRow(100, "c"),
      textReplyRow(9, "a"),
      textReplyRow(10, "b"),
    ];
    expect(parseTranscriptEntries(rows).map((e) => e.seq)).toEqual([
      "9",
      "10",
      "100",
    ]);
  });
});

describe("parseEntriesResponse", () => {
  it("reads generation and entries; a missing generation means 0", () => {
    const parsed = parseEntriesResponse({ entries: [textReplyRow(5, "hi")] });
    expect(parsed.generation).toBe("0");
    expect(parsed.entries.map((e) => e.seq)).toEqual(["5"]);
    expect(parseEntriesResponse({ generation: "3", entries: [] })).toEqual({
      generation: "3",
      entries: [],
    });
  });

  it("rejects a response that is not an object", () => {
    expect(() => parseEntriesResponse("nope")).toThrow(GrokBotError);
  });
});
