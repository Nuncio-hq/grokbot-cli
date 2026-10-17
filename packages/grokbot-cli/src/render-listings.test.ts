import { describe, expect, it } from "vitest";
import {
  AGENTS,
  blobRow,
  DEV_1,
  DEV_2,
  entries,
  PRIMARY,
  ROOM,
  row,
  STAFF,
  status,
} from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const say = (content: string) => ({
  kind: "send-message",
  message: { type: "text", content },
});

describe("listing commands in human mode", () => {
  it("prints agents as an aligned table with short ids", async () => {
    const run = await runCli(["agents"], {
      outputs: { agents: { agents: AGENTS } },
    });
    expect(run).toMatchObject({
      stdout: lines(
        "NAME          ID        KIND   HARNESS",
        "Primary Test  f882ec52  agent  temporal",
        "Staff Test    201a8cb2  agent  cursor-agent",
        "GB Test Room  7c0d1e2f  room   -",
      ),
      stderr: "",
      code: 0,
    });
  });

  it("prints team status labels", async () => {
    const members = [
      {
        agent: PRIMARY,
        status: status({ isRunning: true, activityTool: "shell" }),
      },
      {
        agent: STAFF,
        status: status({ awaiting: { reason: "auto-review-approval" } }),
      },
      { agent: DEV_1, status: status({ isRunning: true, isComposing: true }) },
      {
        agent: DEV_2,
        status: status({
          hasRunningSubagents: true,
          boxHandoff: { requestId: "h-1", instruction: "Sign in" },
        }),
      },
      { agent: ROOM, status: status() },
    ];
    const run = await runCli(["team"], { outputs: { team: { members } } });
    expect(run.stdout).toBe(
      lines(
        "NAME          ID        STATUS",
        "Primary Test  f882ec52  running (shell)",
        "Staff Test    201a8cb2  awaiting auto-review-approval",
        "Test-Dev-1    aa11bb22  composing",
        "Test-Dev-2    bb22cc33  awaiting box hand-off",
        "GB Test Room  7c0d1e2f  idle",
      ),
    );
  });

  it("prints tail entries as [seq] kind: text, one line each, cut at 300 chars", async () => {
    const tail = entries([
      row(141, "message", {
        kind: "message",
        role: "user",
        content: "Ask Test-Dev-1\nfor PONG",
        clientNonce: "m-1",
      }),
      row(143, "send-message", say("Messaging Test-Dev-1 now.")),
      row(144, "message", {
        kind: "message",
        role: "assistant",
        content: "say PONG",
        toAgent: { id: DEV_1.agentId, name: "Test-Dev-1", kind: "agent" },
      }),
      row(146, "message", {
        kind: "message",
        role: "user",
        content: "PONG",
        fromAgent: { id: DEV_1.agentId, name: "Test-Dev-1" },
      }),
      row(147, "send-message", say("x".repeat(400))),
      row(148, "send-message", {
        kind: "send-message",
        message: {
          type: "attachment",
          url: "https://files.example/r.pdf",
          file_name: "report.pdf",
        },
      }),
      row(149, "send-message", {
        kind: "send-message",
        message: { type: "widget", status: "pending" },
      }),
      blobRow(150, "abc123"),
      row(151, "tool-call", { kind: "tool-call", name: "shell" }),
      row(152, "send-message", {
        kind: "send-message",
        message: { type: "attachment", url: "https://files.example/x?sig=1" },
      }),
    ]);
    const run = await runCli(["tail", "-n", "10"], {
      outputs: { tail: { agent: PRIMARY, entries: tail } },
    });
    expect(run.stdout).toBe(
      lines(
        "[141] user: Ask Test-Dev-1 for PONG",
        "[143] reply: Messaging Test-Dev-1 now.",
        "[144] assistant to Test-Dev-1: say PONG",
        "[146] user from Test-Dev-1: PONG",
        `[147] reply: ${"x".repeat(299)}…`,
        "[148] reply: report.pdf [attachment]",
        "[149] card: widget",
        "[150] blob: abc123",
        "[151] tool-call",
        "[152] reply: [attachment]",
      ),
    );
  });

  it("says so when the transcript is empty", async () => {
    const run = await runCli(["tail"], {
      outputs: { tail: { agent: STAFF, entries: [] } },
    });
    expect(run.stdout).toBe("No transcript entries for Staff Test.\n");
  });

  it.each([
    [true, "Interrupted the active run on Primary Test.\n"],
    [false, "Primary Test had no active run.\n"],
  ])("prints interrupt with hadActiveRun=%s", async (hadActiveRun, stdout) => {
    const run = await runCli(["interrupt"], {
      outputs: { interrupt: { agent: PRIMARY, hadActiveRun } },
    });
    expect(run).toMatchObject({ stdout, stderr: "", code: 0 });
  });
});
