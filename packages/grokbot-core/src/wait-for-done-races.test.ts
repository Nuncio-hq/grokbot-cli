import { describe, expect, it } from "vitest";
import {
  TRACE_AGENT_ID as AGENT,
  TRACE_BASELINE_SEQ,
  TRACE_MESSAGE_ID,
  TRACE_ROWS,
} from "./fixtures/delegation-trace.js";
import { fakeBot } from "./fixtures/fake-bot.js";
import { fakeServer, hangUntilAborted } from "./fixtures/fake-server.js";
import { textReplyRow, userRow } from "./fixtures/wire-entries.js";
import { type WaitResult, waitForDone } from "./wait-for-done.js";

const job = { agentId: AGENT, sentMessageId: "m-1", baselineUpdatedSeq: "9" };
const ECHO = userRow(10, "ping", { clientNonce: "m-1", requestId: "r1" });
const NOTE = textReplyRow(11, "Working on it.", "r1");
const FINAL = textReplyRow(12, "PONG", "r1");
const rows = (...entries: unknown[]) => ({ rows: { agentId: AGENT, entries } });
const idleFrame = { agentState: { live: [{ agentId: AGENT }] } };
const later = (ms: number, act: () => void) => setTimeout(act, ms);
const finalReply = (result: WaitResult) =>
  result.status === "done" ? result.finalReply : result.status;

describe("waitForDone never settles on a status newer than its rows", () => {
  it("reads the rows after the status when the bot finished during the reconnect", async () => {
    const bot = fakeBot(AGENT, [ECHO]);
    const { server } = fakeServer({
      calls: bot.calls,
      streams: [
        async function* () {
          bot.commit(NOTE);
          yield rows(NOTE);
          bot.commit(FINAL);
          bot.setLive({});
        },
      ],
    });
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 1_000,
      reconnectDelayMs: 1,
      quietWindowMs: 0,
    });
    expect(finalReply(result)).toBe("PONG");
  });

  it("holds a stream idle status for the quiet window until the final row lands", async () => {
    const bot = fakeBot(AGENT, [ECHO]);
    const { server } = fakeServer({
      calls: bot.calls,
      streams: [
        async function* () {
          bot.commit(NOTE);
          yield rows(NOTE);
          bot.setLive({});
          later(20, () => bot.commit(FINAL));
          yield* hangUntilAborted([idleFrame]);
        },
      ],
    });
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 1_000,
      quietWindowMs: 100,
    });
    expect(finalReply(result)).toBe("PONG");
  });

  it("does not trust an idle snapshot sent before the run's rows", async () => {
    const { echo, progressNote, delegation, sentNote } = TRACE_ROWS;
    const bot = fakeBot(AGENT, [echo, progressNote]);
    const { server } = fakeServer({
      calls: bot.calls,
      streams: [
        async function* () {
          later(20, () => bot.commit(delegation, sentNote));
          later(40, () => {
            bot.commit(TRACE_ROWS.employeeReply, TRACE_ROWS.finalReply);
            bot.setLive({});
          });
          yield* hangUntilAborted([
            { connected: { streamId: "s1", absoluteLifetimeMs: "1" } },
            { agentState: { snapshot: true, live: [{ agentId: AGENT }] } },
          ]);
        },
      ],
    });
    const result = await waitForDone({
      server,
      job: {
        agentId: AGENT,
        sentMessageId: TRACE_MESSAGE_ID,
        baselineUpdatedSeq: TRACE_BASELINE_SEQ,
      },
      timeoutMs: 1_000,
      quietWindowMs: 100,
    });
    expect(finalReply(result)).toBe("RESULT: PONG");
  });

  it("keeps the edited version of a row when the stream replays the older one", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [ECHO] }],
        ListGrokBotAgentStatuses: [
          { statuses: [{ agentId: AGENT, live: { isRunning: true } }] },
          { statuses: [{ agentId: AGENT }] },
        ],
      },
      streams: [
        () =>
          hangUntilAborted([
            rows(textReplyRow(11, "PONG", "r1", { updatedSeq: 13 })),
            rows(textReplyRow(11, "PONG (draft)", "r1")),
            idleFrame,
          ]),
      ],
    });
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 1_000,
      quietWindowMs: 0,
    });
    expect(finalReply(result)).toBe("PONG");
  });
});
