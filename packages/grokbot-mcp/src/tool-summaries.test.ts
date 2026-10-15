import { IDLE_STATUS, type Seq, type TranscriptEntry } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY_TEST } from "./fixtures/mcp-session.js";
import { summarize } from "./tool-summaries.js";

const STAFF_TEST = {
  ...PRIMARY_TEST,
  agentId: "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
  name: "Staff Test",
} as typeof PRIMARY_TEST;
const DEV_1_ID = "aa11bb22-cc33-4d44-8e55-ff6677889900";

describe("summarize", () => {
  it("lists agents one per line with kind and id", () => {
    expect(summarize("agents", { agents: [PRIMARY_TEST] })).toBe(
      "1 agent:\n- Primary Test (agent, f882ec52-17b1-4639-b0fc-07fed7526b09)",
    );
  });

  it("shows each team member as idle, running with its tool, or awaiting", () => {
    expect(
      summarize("team", {
        members: [
          { agent: PRIMARY_TEST, status: IDLE_STATUS },
          {
            agent: STAFF_TEST,
            status: { ...IDLE_STATUS, isRunning: true, activityTool: "shell" },
          },
          {
            agent: { ...PRIMARY_TEST, name: "Test-Dev-1" },
            status: { ...IDLE_STATUS, awaiting: { reason: "secret-request" } },
          },
        ],
      }),
    ).toBe(
      "3 agents:\n- Primary Test: idle\n- Staff Test: running (shell)\n- Test-Dev-1: awaiting owner (secret-request)",
    );
  });

  it("points send and wait results at grokbot_wait with the job id", () => {
    expect(
      summarize("send", {
        jobId: "job-5",
        agent: PRIMARY_TEST,
        sentMessageId: "m-1",
      }),
    ).toBe(
      'Sent to Primary Test. Job job-5 is saved; call grokbot_wait with {"job":"job-5"} for the reply.',
    );
    expect(
      summarize("wait", {
        jobId: "job-5",
        agentId: PRIMARY_TEST.agentId,
        outcome: { status: "done", finalReply: "RESULT: PONG", replies: [] },
      }),
    ).toBe("Agent f882ec52-17b1-4639-b0fc-07fed7526b09 replied:\nRESULT: PONG");
  });

  it("renders tail entries by kind with their seq", () => {
    const base = { updatedSeq: "0" as Seq, entryId: "", entryKind: "" };
    const stamp = { requestId: undefined, timestampMs: undefined };
    const entries: TranscriptEntry[] = [
      {
        ...base,
        ...stamp,
        seq: "144" as Seq,
        kind: "assistant-message",
        content: "Messaging Test-Dev-1 now.",
        toAgent: { id: DEV_1_ID, name: "Test-Dev-1" },
      },
      {
        ...base,
        ...stamp,
        seq: "146" as Seq,
        kind: "user-message",
        content: "PONG",
        clientNonce: undefined,
        fromAgent: { id: DEV_1_ID, name: "Test-Dev-1" },
      },
      {
        ...base,
        ...stamp,
        seq: "147" as Seq,
        kind: "reply",
        reply: { type: "text", content: "RESULT: PONG" },
      },
      { ...base, seq: "148" as Seq, kind: "blob", blobHash: "ab12" },
      {
        ...base,
        ...stamp,
        seq: "149" as Seq,
        kind: "reply",
        reply: {
          type: "attachment",
          url: "https://files.example/r.pdf?sig=abc",
          fileName: "report.pdf",
        },
      },
    ];
    expect(summarize("tail", { agent: PRIMARY_TEST, entries })).toBe(
      [
        "Primary Test, last 5 entries:",
        "#144 assistant (to Test-Dev-1): Messaging Test-Dev-1 now.",
        "#146 user (from Test-Dev-1): PONG",
        "#147 reply: RESULT: PONG",
        "#148 blob ab12",
        "#149 reply: report.pdf [attachment]",
      ].join("\n"),
    );
  });

  it("says whether interrupt stopped a run", () => {
    expect(
      summarize("interrupt", { agent: PRIMARY_TEST, hadActiveRun: true }),
    ).toBe("Interrupted the active run on Primary Test.");
    expect(
      summarize("interrupt", { agent: STAFF_TEST, hadActiveRun: false }),
    ).toBe("Staff Test had no active run.");
  });
});
