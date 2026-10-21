import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  fakeServer,
  hangUntilAborted,
  type ScriptedStream,
} from "./fixtures/fake-server.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";
import { waitForDone } from "./wait-for-done.js";

const AGENT = "agent-1";
const job = { agentId: AGENT, sentMessageId: "m-1", baselineUpdatedSeq: "9" };
const echo = userRow(10, "ping", { clientNonce: "m-1", requestId: "r1" });
const reply = textReplyRow(11, "PONG", "r1");

const settlement = (
  outcome: string,
  extra: Record<string, unknown> = {},
  turnId = "r1",
) => ({
  lastTurnSettlement: { turnId, outcome, settledAtMs: "1000", ...extra },
});
const status = (live: Record<string, unknown>) => ({
  statuses: [{ agentId: AGENT, live }],
});
const frame = (live: Record<string, unknown>) => ({
  agentState: { live: [{ agentId: AGENT, ...live }] },
});
const rows = (...entries: unknown[]) => ({ rows: { agentId: AGENT, entries } });
const stayOpen =
  (...frames: unknown[]): ScriptedStream =>
  () =>
    hangUntilAborted(frames);

/** A quiet window and reconnect pause far beyond the timeout: only a shortcut can finish in time. */
const SLOW = { quietWindowMs: 30_000, reconnectDelayMs: 30_000 };

function wait(
  backlog: readonly unknown[][],
  statuses: unknown[],
  streams: ScriptedStream[] = [],
  options: { quietWindowMs?: number; reconnectDelayMs?: number } = SLOW,
) {
  const { server, log } = fakeServer({
    calls: {
      ListGrokBotTranscriptEntries: backlog.map((entries) => ({ entries })),
      ListGrokBotAgentStatuses: statuses,
    },
    streams,
  });
  const result = waitForDone({ server, job, timeoutMs: 2_000, ...options });
  return { result, log };
}

describe("waitForDone with the server's settlement of the turn", () => {
  it("finishes without the quiet window while the bot already runs a later turn", async () => {
    const { result } = wait(
      [[echo, reply]],
      [status({ isRunning: true })],
      [stayOpen(frame({ isRunning: true, ...settlement("success") }))],
    );
    const done = await result;
    expect(done.status === "done" && done.finalReply).toBe("PONG");
  });

  it("finishes on the first status read when the settlement is already there", async () => {
    const { result, log } = wait(
      [[echo, reply]],
      [status({ isRunning: true, ...settlement("success") })],
    );
    const done = await result;
    expect(done.status === "done" && done.finalReply).toBe("PONG");
    expect(log.some((c) => c.kind === "stream")).toBe(false);
  });

  it("remembers a settlement the next run cleared", async () => {
    const { result } = wait(
      [[echo]],
      [status({ isRunning: true })],
      [
        stayOpen(
          frame({ isRunning: true, ...settlement("success") }),
          frame({ isRunning: true }),
          rows(reply),
        ),
      ],
    );
    const done = await result;
    expect(done.status === "done" && done.finalReply).toBe("PONG");
  });

  it("ignores the settlement of another turn", async () => {
    const other = settlement("error", { errorCode: "OTHER" }, "r0");
    const { result } = wait(
      [[echo]],
      [status({ isRunning: true })],
      [
        [
          frame({ isRunning: true, ...other }),
          rows(reply),
          frame({ ...other }),
        ],
      ],
      { quietWindowMs: 0, reconnectDelayMs: 1 },
    );
    const done = await result;
    expect(done.status === "done" && done.finalReply).toBe("PONG");
  });
});

describe("waitForDone on an error or cancellation settlement", () => {
  const failure = (promise: Promise<unknown>) =>
    promise.catch((e: unknown) => e);

  it("fails at once with the error code and domain, without the bot going idle", async () => {
    const failed = settlement("error", {
      errorCode: "RATE_LIMITED",
      errorDomain: "model_quota",
    });
    const { result } = wait(
      [[echo]],
      [status({ isRunning: true })],
      [stayOpen(frame({ isRunning: true, ...failed }))],
    );
    const error = await failure(result);
    expect(error).toBeInstanceOf(GrokBotError);
    expect(error).toMatchObject({
      code: "protocol",
      message: expect.stringContaining(`agent ${AGENT} failed its turn`),
    });
    const { message } = error as GrokBotError;
    expect([
      message.includes("RATE_LIMITED"),
      message.includes("model_quota"),
    ]).toEqual([true, true]);
  });

  it("fails on the first status read when the settlement is already there", async () => {
    const { result, log } = wait(
      [[echo]],
      [
        status({
          isRunning: true,
          ...settlement("error", { errorCode: "E1" }),
        }),
      ],
    );
    const error = await failure(result);
    expect(error).toMatchObject({
      code: "protocol",
      message: expect.stringContaining("E1"),
    });
    expect(log.some((c) => c.kind === "stream")).toBe(false);
  });

  it("returns the reply when the fresh read finds one the stream had not delivered", async () => {
    const { result } = wait(
      [[echo], [echo, reply]],
      [status({ isRunning: true })],
      [stayOpen(frame({ isRunning: true, ...settlement("error") }))],
    );
    const done = await result;
    expect(done.status === "done" && done.finalReply).toBe("PONG");
  });

  it("fails a cancelled turn without a reply and returns the reply of one with it", async () => {
    const cancelled = settlement("cancelled");
    const silent = wait(
      [[echo]],
      [status({ isRunning: true })],
      [stayOpen(frame({ isRunning: true, ...cancelled }))],
    );
    expect(await failure(silent.result)).toMatchObject({
      code: "protocol",
      message: expect.stringContaining("cancelled"),
    });
    const answered = wait(
      [[echo, reply]],
      [status({ isRunning: true })],
      [stayOpen(frame({ isRunning: true, ...cancelled }))],
    );
    const done = await answered.result;
    expect(done.status === "done" && done.finalReply).toBe("PONG");
  });
});

describe("waitForDone when a subagent ran in the turn", () => {
  it("keeps to the live status: the subagent's end starts the run that answers", async () => {
    const startedAtMs = String(1_791_948_600_000 + 20);
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [echo, reply] }],
        ListGrokBotAgentStatuses: [status({ isRunning: true })],
        ListGrokBotSubagents: [
          { subagents: [{ subagentId: "s", startedAtMs }] },
        ],
      },
      streams: [
        stayOpen(
          frame({ isRunning: true, hasRunningSubagents: true }),
          frame({ isRunning: true, ...settlement("success") }),
        ),
      ],
    });
    const error = await waitForDone({
      server,
      job,
      timeoutMs: 300,
      ...SLOW,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "timeout" });
  });
});
