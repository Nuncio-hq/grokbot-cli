import { Buffer } from "node:buffer";
import {
  IDLE_STATUS,
  parseTranscriptEntries,
  type Seq,
  type TranscriptEntry,
} from "grokbot-core";
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
  it("lists each agent with its name, kind and id and counts them", () => {
    const text = summarize("agents", { agents: [PRIMARY_TEST] });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toMatch(/^1 agent/);
    for (const fact of ["Primary Test", "agent", PRIMARY_TEST.agentId]) {
      expect(text).toContain(fact);
    }
  });

  it("shows each team member as idle, running with its tool, or awaiting", () => {
    const lines = summarize("team", {
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
    }).split("\n");
    expect(lines[0]).toMatch(/^3 agents/);
    expect(lines[1]).toContain("Primary Test");
    expect(lines[1]).toContain("idle");
    expect(lines[2]).toContain("Staff Test");
    expect(lines[2]).toContain("running");
    expect(lines[2]).toContain("shell");
    expect(lines[3]).toContain("Test-Dev-1");
    expect(lines[3]).toContain("secret-request");
  });

  it("shows a team member blocked on a box hand-off with its instruction", () => {
    const [, line] = summarize("team", {
      members: [
        {
          agent: PRIMARY_TEST,
          status: {
            ...IDLE_STATUS,
            boxHandoff: { requestId: "h-1", instruction: "Sign in to Xero" },
          },
        },
      ],
    }).split("\n");
    expect(line).toContain("Primary Test");
    expect(line).toContain("Sign in to Xero");
    expect(line).not.toContain("idle");
  });

  it("names each blocking card and the hand-off when a job awaits the owner", () => {
    const body = {
      kind: "send-message",
      message: {
        type: "user-form",
        formRequest: { title: "Address", fields: [] },
      },
    };
    const row = {
      seq: "4",
      entryId: "t4s0",
      entryKind: "send-message",
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    };
    const cards = parseTranscriptEntries([row]).filter(
      (e): e is Extract<TranscriptEntry, { kind: "card" }> => e.kind === "card",
    );
    const outcome = {
      status: "awaiting-approval",
      reason: "Take over the bot's computer: Sign in to Xero",
      handoff: { requestId: "h-1", instruction: "Sign in to Xero" },
      cards,
    } as const;
    const text = summarize("ask", {
      jobId: "job-7",
      agent: PRIMARY_TEST,
      outcome,
    });
    const lines = text.split("\n");
    expect(lines[0]).toContain("Primary Test");
    expect(lines[0]).toContain(outcome.reason);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(2);
    expect(text).toContain("Sign in to Xero");
    expect(text).toContain("user-form");
    expect(text).toContain("Address");
    expect(text).toContain(`{"job":"job-7"}`);
  });

  it("points send and wait results at grokbot_wait with the job id", () => {
    const sent = { jobId: "job-5", agent: PRIMARY_TEST, sentMessageId: "m-1" };
    for (const queued of [false, true]) {
      const text = summarize("send", { ...sent, queued });
      expect(text).toContain("Primary Test");
      expect(text).toContain(`grokbot_wait with {"job":"job-5"}`);
    }
    expect(summarize("send", { ...sent, queued: true })).toMatch(/queued/i);
    expect(summarize("send", { ...sent, queued: false })).not.toMatch(
      /queued/i,
    );
    expect(
      summarize("wait", {
        jobId: "job-5",
        agentId: PRIMARY_TEST.agentId,
        agentName: "Primary Test",
        outcome: { status: "done", finalReply: "RESULT: PONG", replies: [] },
      }),
    ).toMatch(/^Primary Test .*\nRESULT: PONG$/);
  });

  it("tells a setup-bots caller the reply, then which tools show the project list, answer, wait for the Setup check item and close it", () => {
    const jobId = "0123456789abcdef";
    const outcomes = [
      { status: "done", finalReply: "My projects: Alpha", replies: [] },
      { status: "pending", reason: "no Done verdict within 45000 ms" },
    ] as const;
    const [settled, unsettled] = outcomes.map((outcome) =>
      summarize("setup-bots", { jobId, agent: PRIMARY_TEST, outcome }),
    ) as [string, string];
    expect(settled).toContain("My projects: Alpha");
    expect(unsettled).toContain(`grokbot_wait with {"job":"${jobId}"}`);
    for (const text of [settled, unsettled]) {
      expect(text).toContain(`grokbot_reply {"job":"${jobId}"`);
      expect(text).toContain(`grokbot_inbox_wait {"job":["01234567"]}`);
      expect(text).toContain(`grokbot_inbox_done {"id":"<item id>"`);
      expect(text).toContain("Setup check");
    }
  });

  it("says a wait that timed out while queued has not sent the message", () => {
    const reason =
      "Primary Test is busy with earlier work, so the message is queued and not sent yet";
    const text = summarize("wait", {
      jobId: "job-7",
      agentId: PRIMARY_TEST.agentId,
      agentName: "Primary Test",
      outcome: { status: "pending", reason, queued: true },
    });
    expect(text).toContain(reason);
    expect(text).toContain(`grokbot_wait with {"job":"job-7"}`);
  });

  it("names a job saved before names were recorded by its agentId", () => {
    const text = summarize("wait", {
      jobId: "job-5",
      agentId: PRIMARY_TEST.agentId,
      outcome: { status: "done", finalReply: "PONG", replies: [] },
    });
    expect(text).toContain(PRIMARY_TEST.agentId);
    expect(text.endsWith("\nPONG")).toBe(true);
  });

  it("flags an ambiguous reply and gives every reply of the shared run", () => {
    const text = summarize("wait", {
      jobId: "job-6",
      agentId: PRIMARY_TEST.agentId,
      agentName: "Primary Test",
      outcome: {
        status: "ambiguous",
        reason: "the bot answered it together with message #171 in one run",
        replyText: "Starting A.\n\nRESULT B\n\nRESULT A",
        replies: [],
      },
    });
    expect(text).toContain("Primary Test");
    expect(text).toContain("ambiguous");
    expect(text).toContain("message #171");
    expect(text.endsWith("Starting A.\n\nRESULT B\n\nRESULT A")).toBe(true);
  });

  it("renders tail entries by kind with their seq", () => {
    const base = { updatedSeq: "0" as Seq, entryKind: "" };
    const stamp = { requestId: undefined, timestampMs: undefined };
    const entries: TranscriptEntry[] = [
      {
        ...base,
        ...stamp,
        seq: "144" as Seq,
        entryId: "t9s144",
        kind: "assistant-message",
        content: "Messaging Test-Dev-1 now.",
        toAgent: { id: DEV_1_ID, name: "Test-Dev-1" },
      },
      {
        ...base,
        ...stamp,
        seq: "146" as Seq,
        entryId: "t10u",
        kind: "user-message",
        content: "PONG",
        clientNonce: undefined,
        fromAgent: { id: DEV_1_ID, name: "Test-Dev-1" },
      },
      {
        ...base,
        ...stamp,
        seq: "147" as Seq,
        entryId: "t10s147",
        kind: "reply",
        reply: { type: "text", content: "RESULT: PONG" },
      },
      {
        ...base,
        seq: "148" as Seq,
        entryId: "e148",
        kind: "blob",
        blobHash: "ab12",
      },
      {
        ...base,
        ...stamp,
        seq: "149" as Seq,
        entryId: "t10s149",
        kind: "reply",
        reply: {
          type: "attachment",
          url: "https://files.example/r.pdf?sig=abc",
          fileName: "report.pdf",
        },
      },
    ];
    const lines = summarize("tail", { agent: PRIMARY_TEST, entries }).split(
      "\n",
    );
    expect(lines).toHaveLength(entries.length + 1);
    expect(lines[0]).toContain("Primary Test");
    expect(lines[0]).toContain("5");
    const expected: [string, string[]][] = [
      [
        "#144",
        ["t9s144", "assistant", "Test-Dev-1", "Messaging Test-Dev-1 now."],
      ],
      ["#146", ["t10u", "user", "Test-Dev-1", "PONG"]],
      ["#147", ["t10s147", "reply", "RESULT: PONG"]],
      ["#148", ["e148", "blob", "ab12"]],
      ["#149", ["t10s149", "reply", "report.pdf", "attachment"]],
    ];
    for (const [index, [seq, facts]] of expected.entries()) {
      expect(lines[index + 1]?.startsWith(seq), seq).toBe(true);
      for (const fact of facts) expect(lines[index + 1], seq).toContain(fact);
    }
    expect(lines.join("\n")).not.toContain("sig=abc");
  });

  describe("search", () => {
    const match = (seq: number, role: string, snippet: string) => ({
      entryId: `t${seq}`,
      seq,
      role,
      timestampMs: Date.UTC(2026, 9, 22, 4, 27, 22),
      snippet,
    });

    it("lists each match with its seq, entry id, role, UTC time and one-line words", () => {
      const lines = summarize("search", {
        agent: PRIMARY_TEST,
        query: "PONG",
        matches: [
          match(425, "assistant", "MAIN-PONG"),
          match(424, "user", "say\n PONG"),
        ],
        isComplete: true,
      }).split("\n");
      expect(lines).toEqual([
        'Primary Test, 2 matches for "PONG", newest first:',
        "#425 [t425] assistant 2026-10-22T04:27Z: MAIN-PONG",
        "#424 [t424] user 2026-10-22T04:27Z: say PONG",
      ]);
    });

    it("says so when nothing matches", () => {
      expect(
        summarize("search", {
          agent: PRIMARY_TEST,
          query: "nothing",
          matches: [],
          isComplete: true,
        }),
      ).toBe('No matches for "nothing" in Primary Test\'s conversation.');
    });

    it("names the call that reads the next page, for the same bot", () => {
      const text = summarize("search", {
        agent: PRIMARY_TEST,
        query: "PONG",
        matches: [match(424, "user", "PONG")],
        isComplete: true,
        nextBeforeSeq: 424,
      });
      expect(text.split("\n").at(-1)).toBe(
        `There may be older matches: call grokbot_search with ${JSON.stringify({ query: "PONG", before: 424, agent: PRIMARY_TEST.agentId })}.`,
      );
    });
  });

  it("says whether interrupt stopped a run", () => {
    const stopped = summarize("interrupt", {
      agent: PRIMARY_TEST,
      hadActiveRun: true,
    });
    const idle = summarize("interrupt", {
      agent: STAFF_TEST,
      hadActiveRun: false,
    });
    expect(stopped).toContain("Primary Test");
    expect(idle).toContain("Staff Test");
    expect(idle).toMatch(/no active run/i);
    expect(stopped).not.toMatch(/no active run/i);
  });
});
