import { describe, expect, it } from "vitest";
import { TRACE_AGENT_ID as AGENT } from "./fixtures/delegation-trace.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { blobRow, textReplyRow, userRow } from "./fixtures/wire-entries.js";
import type { FetchLike } from "./server-transport.js";
import {
  type WaitEvent,
  type WaitResult,
  waitForDone,
} from "./wait-for-done.js";

const job = { agentId: AGENT, sentMessageId: "m-1", baselineUpdatedSeq: "9" };
const ECHO = userRow(10, "ping", { clientNonce: "m-1", requestId: "r1" });
const NOTE = textReplyRow(11, "Writing the long answer.", "r1");
const BLOB = blobRow(12, "send-message", "abc123");
const BODY = {
  kind: "send-message",
  id: "t12",
  message: { type: "text", content: "LONG ANSWER" },
  requestId: "r1",
};
const URL = "https://store.test/blobs/abc123?X-Signature=secret-sig";
const PRESIGNED = {
  reads: [{ relPath: "blobs/abc123", url: URL, expiresAtMs: "1791948600000" }],
};
const MARKER = "[reply stored as blob abc123; run grokbot tail]";

function waitOnBlob(presign: unknown, fetch: FetchLike) {
  const { server, log } = fakeServer({
    calls: {
      ListGrokBotTranscriptEntries: [{ entries: [ECHO, NOTE, BLOB] }],
      ListGrokBotAgentStatuses: [{ statuses: [{ agentId: AGENT }] }],
      PresignSandBoxStoreReads: [presign],
    },
  });
  const events: WaitEvent[] = [];
  const wait = waitForDone({
    server,
    job,
    timeoutMs: 1_000,
    fetch,
    onEvent: (e) => events.push(e),
  });
  return { wait, log, events };
}

const summary = (result: WaitResult) =>
  result.status === "done" && [
    result.finalReply,
    result.blobHash,
    result.replies.map((r) => r.seq),
  ];

describe("waitForDone on a final reply stored as a blob", () => {
  it("downloads the blob once and returns its text", async () => {
    const gets: [string, string | undefined][] = [];
    const { wait, log, events } = waitOnBlob(PRESIGNED, async (url, init) => {
      gets.push([url, init.method]);
      return new Response(JSON.stringify(BODY));
    });
    expect([
      summary(await wait),
      log
        .filter((c) => c.method === "PresignSandBoxStoreReads")
        .map((c) => c.body),
      gets,
      JSON.stringify(events).includes("secret-sig"),
    ]).toEqual([
      ["LONG ANSWER", undefined, ["11", "12"]],
      [{ relPaths: ["blobs/abc123"] }],
      [[URL, "GET"]],
      false,
    ]);
  });

  it.each<[string, unknown, FetchLike]>([
    [
      "the download answers 404",
      PRESIGNED,
      async () => new Response("missing", { status: 404 }),
    ],
    [
      "the presign response has no URL",
      { reads: [{ relPath: "blobs/abc123" }] },
      async () => new Response(JSON.stringify(BODY)),
    ],
    [
      "the download fails on the network",
      PRESIGNED,
      async () => {
        throw new TypeError(`fetch failed for ${URL}`);
      },
    ],
    [
      "the body is not a text reply",
      PRESIGNED,
      async () => new Response(JSON.stringify({ kind: "send-message" })),
    ],
  ])(
    "returns the blob marker, not the earlier note, when %s",
    async (_, presign, fetch) => {
      const { wait, events } = waitOnBlob(presign, fetch);
      expect([
        summary(await wait),
        JSON.stringify(events).includes("secret-sig"),
      ]).toEqual([[MARKER, "abc123", ["11"]], false]);
    },
  );
});
