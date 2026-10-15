import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  TRACE_AGENT_ID as AGENT,
  TRACE_BASELINE_SEQ,
  TRACE_MESSAGE_ID,
  TRACE_ROWS,
} from "./fixtures/delegation-trace.js";
import {
  fakeServer,
  hangUntilAborted,
  type ScriptedStream,
} from "./fixtures/fake-server.js";
import {
  delegateReplyRow,
  sendMessageRow,
  textReplyRow,
  userRow,
} from "./fixtures/wire-entries.js";
import { type WaitEvent, waitForDone } from "./wait-for-done.js";

const job = {
  agentId: AGENT,
  sentMessageId: TRACE_MESSAGE_ID,
  baselineUpdatedSeq: TRACE_BASELINE_SEQ,
};
const running = {
  statuses: [{ agentId: AGENT, isRunning: true, live: { isRunning: true } }],
};
const idle = { statuses: [{ agentId: AGENT }] };
const state = (live: Record<string, unknown>) => ({
  agentState: { live: [{ agentId: AGENT, ...live }] },
});
const rows = (...entries: unknown[]) => ({ rows: { agentId: AGENT, entries } });
const reasons = (events: WaitEvent[]) =>
  events.flatMap((e) =>
    e.type === "verdict"
      ? [e.verdict.status === "running" ? e.verdict.reason : e.verdict.status]
      : [],
  );

describe("waitForDone on the delegation trace split across a reconnect", () => {
  it("returns #147 RESULT: PONG, not the #143 progress note", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          {
            entries: [
              textReplyRow(141, "old turn"),
              TRACE_ROWS.echo,
              TRACE_ROWS.progressNote,
            ],
          },
        ],
        ListGrokBotAgentStatuses: [running, idle],
      },
      streams: [
        [
          { connected: { streamId: "s1", absoluteLifetimeMs: "1195000" } },
          {
            agentState: {
              snapshot: true,
              live: [{ agentId: AGENT, isRunning: true }, { agentId: "dev-1" }],
            },
          },
          rows(TRACE_ROWS.delegation, TRACE_ROWS.sentNote),
          {
            rows: {
              agentId: "dev-1",
              entries: [
                delegateReplyRow(2, "Test ping", {
                  id: AGENT,
                  name: "Grok Bot",
                }),
              ],
            },
          },
          state({}),
        ],
        [
          rows(TRACE_ROWS.employeeReply),
          state({ isRunning: true }),
          rows(TRACE_ROWS.finalReply),
          state({}),
        ],
      ],
    });
    const events: WaitEvent[] = [];
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 2_000,
      reconnectDelayMs: 1,
      onEvent: (e) => events.push(e),
    });

    expect(
      result.status === "done" && [
        result.finalReply,
        result.replies.map((r) => r.seq),
      ],
    ).toEqual(["RESULT: PONG", ["143", "145", "147"]]);
    expect(reasons(events)).toEqual([
      "target-active",
      "pending-delegation",
      "awaiting-final-reply",
      "target-active",
      "done",
    ]);
    const status = ["ListGrokBotAgentStatuses", { agentIds: [AGENT] }];
    const read = [
      "ListGrokBotTranscriptEntries",
      { agentId: AGENT, sessionId: "", limit: 50 },
    ];
    const watch = (afterUpdatedSeq: string) => [
      "WatchGrokBotTranscripts",
      [{ agentId: AGENT, generation: "0", afterUpdatedSeq, sessionId: "" }],
    ];
    expect(
      log.map((c) => [c.method, c.kind === "stream" ? c.body.cursors : c.body]),
    ).toEqual([status, read, watch("143"), status, read, watch("145"), read]);
  });
});

describe("waitForDone outcomes", () => {
  it("returns at once when the backlog already holds a finished turn", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          {
            entries: [
              userRow(10, "ping", { clientNonce: "m-1" }),
              textReplyRow(11, "PONG"),
            ],
          },
        ],
        ListGrokBotAgentStatuses: [idle],
      },
    });
    const result = await waitForDone({
      server,
      job: { ...job, sentMessageId: "m-1", baselineUpdatedSeq: "9" },
      timeoutMs: 1_000,
    });
    expect(result.status === "done" && result.finalReply).toBe("PONG");
    expect(log.map((c) => c.method)).toEqual([
      "ListGrokBotAgentStatuses",
      "ListGrokBotTranscriptEntries",
    ]);
  });

  it("pages the backlog back to the baseline when the turn is longer than one page", async () => {
    const turn = [
      userRow(10, "ping", { clientNonce: "m-1" }),
      textReplyRow(11, "working"),
      textReplyRow(12, "PONG"),
    ];
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: (body) =>
          body.beforeSeq === "11"
            ? { entries: [turn[0], textReplyRow(9, "older")] }
            : { entries: [turn[2], turn[1]] },
        ListGrokBotAgentStatuses: [idle],
      },
    });
    const result = await waitForDone({
      server,
      job: { ...job, sentMessageId: "m-1", baselineUpdatedSeq: "9" },
      timeoutMs: 1_000,
      backlogLimit: 2,
    });
    expect(
      result.status === "done" && [
        result.finalReply,
        result.replies.map((r) => r.seq),
      ],
    ).toEqual(["PONG", ["11", "12"]]);
    expect(
      log.flatMap((c) =>
        c.method === "ListGrokBotTranscriptEntries"
          ? [c.body.beforeSeq ?? "latest"]
          : [],
      ),
    ).toEqual(["latest", "11"]);
  });

  it("returns awaiting-approval with the open card", async () => {
    const card = sendMessageRow(12, {
      type: "widget",
      ask: { status: "pending" },
    });
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          { entries: [userRow(10, "deploy", { clientNonce: "m-1" })] },
        ],
        ListGrokBotAgentStatuses: [running],
      },
      streams: [
        [
          rows(card),
          state({ isRunning: true, awaiting: { reason: "Pick one" } }),
        ],
      ],
    });
    const result = await waitForDone({
      server,
      job: { ...job, sentMessageId: "m-1", baselineUpdatedSeq: "9" },
      timeoutMs: 1_000,
    });
    expect(
      result.status === "awaiting-approval" && [
        result.reason,
        result.cards.map((c) => c.seq),
      ],
    ).toEqual(["Pick one", ["12"]]);
  });

  it("refetches the backlog on cursorTooOld and reconnects after a stream error", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          { entries: [userRow(10, "ping", { clientNonce: "m-1" })] },
          {
            entries: [
              userRow(10, "ping", { clientNonce: "m-1" }),
              textReplyRow(11, "PONG"),
            ],
          },
        ],
        ListGrokBotAgentStatuses: [running, running, idle],
      },
      streams: [
        [{ cursorTooOld: { agentId: AGENT } }],
        async function* () {
          yield { heartbeat: { serverTimeMs: "1" } };
          throw new Error("socket hang up");
        },
      ],
    });
    const events: WaitEvent[] = [];
    const result = await waitForDone({
      server,
      job: { ...job, sentMessageId: "m-1", baselineUpdatedSeq: "9" },
      timeoutMs: 1_000,
      reconnectDelayMs: 1,
      onEvent: (e) => events.push(e),
    });
    expect(result.status === "done" && result.finalReply).toBe("PONG");
    expect(events.filter((e) => e.type === "reconnecting")).toEqual([
      { type: "reconnecting", reason: "socket hang up" },
    ]);
    expect(log.map((c) => c.method)).toEqual([
      "ListGrokBotAgentStatuses",
      "ListGrokBotTranscriptEntries",
      "WatchGrokBotTranscripts",
      "ListGrokBotAgentStatuses",
      "ListGrokBotTranscriptEntries",
      "WatchGrokBotTranscripts",
      "ListGrokBotAgentStatuses",
      "ListGrokBotTranscriptEntries",
    ]);
  });

  it("throws a timeout naming the last running reason", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          { entries: [TRACE_ROWS.echo, TRACE_ROWS.progressNote] },
        ],
        ListGrokBotAgentStatuses: [running],
      },
    });
    const error = await waitForDone({ server, job, timeoutMs: 40 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GrokBotError);
    expect([
      (error as GrokBotError).code,
      (error as GrokBotError).message,
    ]).toEqual([
      "timeout",
      "no Done verdict within 40 ms (last: running, target-active)",
    ]);
  });

  it("rethrows the caller's abort reason instead of a timeout", async () => {
    const controller = new AbortController();
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [] }],
        ListGrokBotAgentStatuses: [running],
      },
      streams: [() => hangUntilAborted([], controller.signal)],
    });
    setTimeout(() => controller.abort(new Error("user pressed ctrl-c")), 10);
    await expect(
      waitForDone({ server, job, timeoutMs: 5_000, signal: controller.signal }),
    ).rejects.toThrow("user pressed ctrl-c");
  });

  it("fails fast when the conversation is cleared", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [TRACE_ROWS.echo] }],
        ListGrokBotAgentStatuses: [running],
      },
      streams: [[{ cleared: { agentId: AGENT, newGeneration: "1" } }]],
    });
    await expect(
      waitForDone({ server, job, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("waitForDone on a turnFailed frame", () => {
  const ping = userRow(10, "ping", { clientNonce: "m-1" });
  const retrying = {
    statuses: [{ agentId: AGENT, live: { isRetrying: true } }],
  };
  const failed = (payload: Record<string, unknown>, agentId = AGENT) => ({
    turnFailed: { agentId, ...payload },
  });
  const stayOpen =
    (...frames: unknown[]) =>
    () =>
      hangUntilAborted(frames);
  const wait = (
    statuses: unknown[],
    streams: ScriptedStream[],
    backlog: unknown[] = [ping],
  ) => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: backlog }],
        ListGrokBotAgentStatuses: statuses,
      },
      streams,
    });
    return waitForDone({
      server,
      job: { ...job, sentMessageId: "m-1", baselineUpdatedSeq: "9" },
      timeoutMs: 1_000,
      reconnectDelayMs: 1,
    });
  };

  it.each<[string, Record<string, unknown>, string]>([
    [
      "error.message",
      { error: { message: "model overloaded" } },
      "model overloaded",
    ],
    ["an empty payload", {}, "turn failed"],
    ["error as a string", { error: "boom" }, "boom"],
    [
      "failureCode",
      { failureCode: "RESOURCE_EXHAUSTED_PER_MINUTE_QUOTA" },
      "RESOURCE_EXHAUSTED_PER_MINUTE_QUOTA",
    ],
    [
      "a message holding a token",
      { message: "denied:\n  Bearer synthetic-access-token-0123456789" },
      "denied: Bearer [redacted]",
    ],
    [
      "a bare opaque key",
      { reason: "key opaque-run-0123456789abcdef rejected" },
      "key [redacted] rejected",
    ],
    [
      "a reason over 200 chars",
      { reason: "no capacity ".repeat(20) },
      `${"no capacity ".repeat(16)}no capac`,
    ],
  ])(
    "throws protocol once the bot stops, reading the reason from %s",
    async (_, payload, reason) => {
      const error = await wait(
        [running, idle],
        [stayOpen(failed(payload))],
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GrokBotError);
      expect([
        (error as GrokBotError).code,
        (error as GrokBotError).message,
      ]).toEqual(["protocol", `agent ${AGENT} failed its turn: ${reason}`]);
    },
  );

  it("keeps waiting while the live status says retrying and returns the retry's reply", async () => {
    const result = await wait(
      [running, retrying],
      [
        [state({}), failed({ message: "rate limited" })],
        [rows(textReplyRow(11, "PONG")), state({})],
      ],
    );
    expect(result.status === "done" && result.finalReply).toBe("PONG");
  });

  it("keeps waiting on an open delegation, whose reply starts a new request", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          {
            entries: [
              TRACE_ROWS.echo,
              TRACE_ROWS.progressNote,
              TRACE_ROWS.delegation,
              TRACE_ROWS.sentNote,
            ],
          },
        ],
        ListGrokBotAgentStatuses: [running, idle],
      },
      streams: [
        stayOpen(failed({ message: "turn crashed" })),
        [
          rows(TRACE_ROWS.employeeReply),
          state({ isRunning: true }),
          rows(TRACE_ROWS.finalReply),
          state({}),
        ],
      ],
    });
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 1_000,
      reconnectDelayMs: 1,
    });
    expect(result.status === "done" && result.finalReply).toBe("RESULT: PONG");
  });

  it("keeps waiting when the failure lands before our message is echoed", async () => {
    const result = await wait(
      [running, idle],
      [
        stayOpen(failed({ message: "earlier turn crashed" })),
        [rows(ping, textReplyRow(11, "PONG")), state({})],
      ],
      [],
    );
    expect(result.status === "done" && result.finalReply).toBe("PONG");
  });

  it("ignores a turnFailed frame for another agent", async () => {
    const result = await wait(
      [running, idle],
      [
        [
          failed({ message: "delegate crashed" }, "dev-1"),
          rows(textReplyRow(11, "PONG")),
          state({}),
        ],
      ],
    );
    expect(result.status === "done" && result.finalReply).toBe("PONG");
  });

  it("returns done when the final reply arrived before the turnFailed frame", async () => {
    const result = await wait(
      [running, idle],
      [
        stayOpen(
          rows(textReplyRow(11, "PONG")),
          failed({ message: "cleanup failed" }),
        ),
      ],
    );
    expect(result.status === "done" && result.finalReply).toBe("PONG");
  });
});
