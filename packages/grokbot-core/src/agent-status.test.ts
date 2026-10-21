import { describe, expect, it } from "vitest";
import {
  IDLE_STATUS,
  isActive,
  parseAgentStatePayload,
  parseAgentStatusesResponse,
  parseLiveStatus,
} from "./agent-status.js";

const A = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const B = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";

describe("parseLiveStatus", () => {
  it("treats an object with every field omitted as idle", () => {
    expect(
      parseLiveStatus({ agentId: A, updatedAtMs: "1", staleAfterMs: "2" }),
    ).toEqual({
      isRunning: false,
      isComposing: false,
      isRetrying: false,
      awaiting: null,
      hasRunningSubagents: false,
      activityTool: undefined,
      boxHandoff: null,
    });
  });

  it("reads running, composing, retrying, subagents and the tool in use", () => {
    expect(
      parseLiveStatus({
        isRunning: true,
        isComposingMessage: true,
        isRetrying: true,
        hasRunningSubagents: true,
        activity: { kind: "tool", tool: "SendToAgent", detail: "x" },
      }),
    ).toEqual({
      isRunning: true,
      isComposing: true,
      isRetrying: true,
      awaiting: null,
      hasRunningSubagents: true,
      activityTool: "SendToAgent",
      boxHandoff: null,
    });
  });

  it("reads a pending box hand-off, and none without a request id", () => {
    expect([
      parseLiveStatus({
        boxHandoffRequestId: "h-1",
        boxHandoffInstruction: "Sign in to the bank site",
      }).boxHandoff,
      parseLiveStatus({ boxHandoffRequestId: "h-2" }).boxHandoff,
      parseLiveStatus({ boxHandoffInstruction: "stale" }).boxHandoff,
    ]).toEqual([
      { requestId: "h-1", instruction: "Sign in to the bank site" },
      { requestId: "h-2", instruction: "" },
      null,
    ]);
  });

  it("reads awaiting as an object or a bare string", () => {
    expect(
      parseLiveStatus({
        awaiting: { tabId: "auto-review", reason: "Approve rm" },
      }).awaiting,
    ).toEqual({ reason: "Approve rm" });
    expect(
      parseLiveStatus({ awaiting: "Permission needed on your computer" })
        .awaiting,
    ).toEqual({
      reason: "Permission needed on your computer",
    });
    expect(parseLiveStatus({ awaiting: {} }).awaiting).toEqual({ reason: "" });
  });
});

describe("parseAgentStatusesResponse", () => {
  it("maps each bot, honouring the top-level isRunning too", () => {
    const statuses = parseAgentStatusesResponse({
      statuses: [
        { agentId: A, client: { unreadCount: 2 } },
        { agentId: B, isRunning: true, live: { activity: { tool: "Bash" } } },
      ],
    });
    expect([...statuses.entries()]).toEqual([
      [A, IDLE_STATUS],
      [B, { ...IDLE_STATUS, isRunning: true, activityTool: "Bash" }],
    ]);
  });
});

describe("parseAgentStatePayload", () => {
  it("reads the snapshot flag and the live array keyed by agent", () => {
    const parsed = parseAgentStatePayload({
      snapshot: true,
      live: [{ agentId: A, isRunning: true }, { agentId: B }],
      client: [{ agentId: A }],
    });
    expect(parsed.snapshot).toBe(true);
    expect([...parsed.statuses.entries()]).toEqual([
      [A, { ...IDLE_STATUS, isRunning: true }],
      [B, IDLE_STATUS],
    ]);
  });

  it("accepts a single live object and a missing snapshot flag", () => {
    const parsed = parseAgentStatePayload({
      live: { agentId: A, isComposingMessage: true },
    });
    expect(parsed.snapshot).toBe(false);
    expect(parsed.statuses.get(A)).toEqual({
      ...IDLE_STATUS,
      isComposing: true,
    });
  });
});

describe("isActive", () => {
  it("is true while running, composing, retrying or with subagents, false only when idle", () => {
    expect(
      [
        IDLE_STATUS,
        { ...IDLE_STATUS, isRunning: true },
        { ...IDLE_STATUS, isComposing: true },
        { ...IDLE_STATUS, hasRunningSubagents: true },
        { ...IDLE_STATUS, isRetrying: true },
      ].map(isActive),
    ).toEqual([false, true, true, true, true]);
  });
});

describe("lastTurnSettlement", () => {
  const RUN = "7d3f1c52-9a0e-4b7e-8d55-2f1c3a4b5c6d";
  const settlementOf = (value: unknown) =>
    parseLiveStatus({ lastTurnSettlement: value }).lastTurnSettlement;

  it("reads the turn, outcome and time of a finished run, the time as int64 text or number", () => {
    expect([
      settlementOf({
        turnId: RUN,
        outcome: "success",
        settledAtMs: "1791948600123",
      }),
      settlementOf({ turnId: RUN, outcome: "cancelled", settledAtMs: 42 }),
    ]).toEqual([
      { turnId: RUN, outcome: "success", settledAtMs: 1_791_948_600_123 },
      { turnId: RUN, outcome: "cancelled", settledAtMs: 42 },
    ]);
  });

  it("reads the nonce and the error fields of a failed run", () => {
    expect(
      settlementOf({
        turnId: RUN,
        outcome: "error",
        settledAtMs: "5",
        clientNonce: "m-1",
        errorCode: "RATE_LIMITED",
        errorDomain: "agent",
        errorRetryable: true,
      }),
    ).toEqual({
      turnId: RUN,
      outcome: "error",
      settledAtMs: 5,
      clientNonce: "m-1",
      errorCode: "RATE_LIMITED",
      errorDomain: "agent",
      errorRetryable: true,
    });
  });

  it("keeps an outcome it does not know, or none, as unknown", () => {
    expect([
      settlementOf({ turnId: RUN, outcome: "paused", settledAtMs: "5" })
        ?.outcome,
      settlementOf({ turnId: RUN, settledAtMs: "5" })?.outcome,
    ]).toEqual(["unknown", "unknown"]);
  });

  it("is absent when the field is missing or cannot be read, and never throws", () => {
    const bad = [
      undefined,
      null,
      "success",
      7,
      [],
      {},
      { outcome: "success", settledAtMs: "5" },
      { turnId: "", outcome: "success", settledAtMs: "5" },
      { turnId: RUN, outcome: "success" },
      { turnId: RUN, outcome: "success", settledAtMs: "soon" },
      { turnId: RUN, outcome: "success", settledAtMs: -1 },
      { turnId: RUN, outcome: "success", settledAtMs: 1.5 },
      { turnId: 12, outcome: "success", settledAtMs: "5" },
    ];
    for (const value of bad) {
      const status = parseLiveStatus({
        isRunning: true,
        lastTurnSettlement: value,
      });
      expect(status).toEqual({ ...IDLE_STATUS, isRunning: true });
      expect("lastTurnSettlement" in status).toBe(false);
    }
    expect("lastTurnSettlement" in parseLiveStatus({})).toBe(false);
  });

  it("is carried by a status read and by an agentState frame", () => {
    const lastTurnSettlement = {
      turnId: RUN,
      outcome: "success",
      settledAtMs: "9",
    };
    const expected = { turnId: RUN, outcome: "success", settledAtMs: 9 };
    const read = parseAgentStatusesResponse({
      statuses: [{ agentId: A, live: { lastTurnSettlement } }],
    });
    const frame = parseAgentStatePayload({
      live: [{ agentId: A, lastTurnSettlement }],
    });
    expect([
      read.get(A)?.lastTurnSettlement,
      frame.statuses.get(A)?.lastTurnSettlement,
    ]).toEqual([expected, expected]);
  });

  it("does not make the bot active", () => {
    const status = parseLiveStatus({
      lastTurnSettlement: { turnId: RUN, outcome: "error", settledAtMs: "9" },
    });
    expect(isActive(status)).toBe(false);
  });
});
