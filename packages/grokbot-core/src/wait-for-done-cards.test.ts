import { describe, expect, it } from "vitest";
import { BLUE_MESSAGE_ID, WIDGET_TRACE as W } from "./fixtures/card-traces.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { type WaitEvent, waitForDone } from "./wait-for-done.js";

const AGENT = "f882ec52-0000-4000-8000-000000000000";
const job = {
  agentId: AGENT,
  sentMessageId: BLUE_MESSAGE_ID,
  baselineUpdatedSeq: "140",
};
const running = { statuses: [{ agentId: AGENT, live: { isRunning: true } }] };
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

describe("waitForDone on a question widget turn", () => {
  it("returns awaiting-approval with the widget once the bot goes idle without live.awaiting", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [{ entries: [W.blueEcho] }],
        ListGrokBotAgentStatuses: [running],
      },
      streams: [[rows(W.blueCard), state({})]],
    });
    const events: WaitEvent[] = [];
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    });
    expect([
      result.status === "awaiting-approval" && [
        result.reason,
        result.cards.map((c) => [c.seq, c.cardType]),
      ],
      reasons(events),
    ]).toEqual([
      ["Which color do you pick?", [["142", "widget"]]],
      ["target-active", "awaiting-approval"],
    ]);
  });

  it("returns the reply the bot posts in a new run after the owner answers", async () => {
    const { server } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          { entries: [W.blueEcho, W.blueCard] },
          { entries: [W.blueEcho, W.blueAnswered, W.blueReply] },
        ],
        ListGrokBotAgentStatuses: [running],
      },
      streams: [[rows(W.blueReply), rows(W.blueAnswered), state({})]],
    });
    const result = await waitForDone({
      server,
      job,
      timeoutMs: 2_000,
      quietWindowMs: 10,
    });
    expect(
      result.status === "done" && [
        result.finalReply,
        result.replies.map((r) => r.seq),
      ],
    ).toEqual(["You picked Blue.", ["144"]]);
  });

  it("finishes a saved widget job from the backlog alone once the reply has landed", async () => {
    const { server, log } = fakeServer({
      calls: {
        ListGrokBotTranscriptEntries: [
          { entries: [W.blueEcho, W.blueAnswered, W.blueReply] },
        ],
        ListGrokBotAgentStatuses: [idle],
      },
    });
    const result = await waitForDone({ server, job, timeoutMs: 1_000 });
    expect([
      result.status === "done" && result.finalReply,
      log.map((c) => c.method),
    ]).toEqual([
      "You picked Blue.",
      ["ListGrokBotAgentStatuses", "ListGrokBotTranscriptEntries"],
    ]);
  });
});
