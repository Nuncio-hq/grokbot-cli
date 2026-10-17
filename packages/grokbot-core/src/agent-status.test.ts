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
