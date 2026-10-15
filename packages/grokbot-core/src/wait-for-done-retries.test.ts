import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { TRACE_AGENT_ID as AGENT } from "./fixtures/delegation-trace.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";
import { type WaitEvent, waitForDone } from "./wait-for-done.js";
import { reconnectBackoff } from "./wait-reconnect.js";

const job = { agentId: AGENT, sentMessageId: "m-1", baselineUpdatedSeq: "9" };
const ECHO = userRow(10, "ping", { clientNonce: "m-1", requestId: "r1" });
const PONG = textReplyRow(11, "PONG", "r1");
const running = { statuses: [{ agentId: AGENT, live: { isRunning: true } }] };
const idle = { statuses: [{ agentId: AGENT }] };
const fast = { timeoutMs: 1_000, reconnectDelayMs: 1, quietWindowMs: 0 };
/** Answers in order, the last one repeating; an Error is thrown instead of returned. */
const sequence = (...answers: unknown[]) => {
  let i = 0;
  return () => {
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
};
const reconnects = (events: WaitEvent[]) =>
  events.flatMap((e) => (e.type === "reconnecting" ? [e.reason] : []));

describe("waitForDone retries failed unary calls through the reconnect path", () => {
  it("retries a status call that fails between reconnects", async () => {
    const http502 = new GrokBotError(
      "http",
      "ListGrokBotAgentStatuses failed with HTTP 502",
    );
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [ECHO] }],
        ListGrokBotAgentStatuses: sequence(running, http502, idle),
      },
      streams: [[{ rows: { agentId: AGENT, entries: [PONG] } }]],
    });
    const events: WaitEvent[] = [];
    const result = await waitForDone({
      server,
      job,
      ...fast,
      onEvent: (e) => events.push(e),
    });
    expect([
      result.status === "done" && result.finalReply,
      reconnects(events),
    ]).toEqual(["PONG", ["ListGrokBotAgentStatuses failed with HTTP 502"]]);
  });

  it("retries a backlog call that fails on the network", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: sequence(new TypeError("fetch failed"), {
          entries: [ECHO, PONG],
        }),
        ListGrokBotAgentStatuses: [idle],
      },
    });
    const events: WaitEvent[] = [];
    const result = await waitForDone({
      server,
      job,
      ...fast,
      onEvent: (e) => events.push(e),
    });
    expect([
      result.status === "done" && result.finalReply,
      reconnects(events),
    ]).toEqual(["PONG", ["fetch failed"]]);
  });

  it("still fails at once on an auth error", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [ECHO] }],
        ListGrokBotAgentStatuses: sequence(
          new GrokBotError("auth", "ListGrokBotAgentStatuses was rejected"),
        ),
      },
    });
    const events: WaitEvent[] = [];
    const error = await waitForDone({
      server,
      job,
      ...fast,
      onEvent: (e) => events.push(e),
    }).catch((e: unknown) => e);
    expect([(error as GrokBotError).code, reconnects(events)]).toEqual([
      "auth",
      [],
    ]);
  });
});

describe("waitForDone reconnect pacing", () => {
  it("doubles the pause from the base up to 15 s and starts over on reset", () => {
    const backoff = reconnectBackoff(1_000);
    const pauses = [1, 2, 3, 4, 5, 6].map(() => backoff.next());
    backoff.reset();
    expect([pauses, backoff.next()]).toEqual([
      [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
      1_000,
    ]);
  });

  it("pauses between streams that end after only connected and snapshot frames", async () => {
    const empty = [
      { connected: { streamId: "s", absoluteLifetimeMs: "1195000" } },
      {
        agentState: {
          snapshot: true,
          live: [{ agentId: AGENT, isRunning: true }],
        },
      },
    ];
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [ECHO] }],
        ListGrokBotAgentStatuses: [running],
      },
      streams: Array.from({ length: 20 }, () => empty),
    });
    const error = await waitForDone({
      server,
      job,
      timeoutMs: 400,
      reconnectDelayMs: 40,
    }).catch((e: unknown) => e);
    expect([
      (error as GrokBotError).code,
      log.filter((c) => c.kind === "stream").length,
    ]).toEqual(["timeout", 4]);
  });

  it("fails with protocol when cursorTooOld repeats three times at one cursor", async () => {
    const tooOld = [{ cursorTooOld: { agentId: AGENT } }];
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [ECHO] }],
        ListGrokBotAgentStatuses: [running],
      },
      streams: [tooOld, tooOld, tooOld, tooOld],
    });
    const error = await waitForDone({ server, job, ...fast }).catch(
      (e: unknown) => e,
    );
    expect([
      (error as GrokBotError).code,
      (error as GrokBotError).message,
      log.filter((c) => c.kind === "stream").length,
    ]).toEqual([
      "protocol",
      `transcript of ${AGENT} reported cursorTooOld 3 times at seq 10`,
      3,
    ]);
  });
});
