import { describe, expect, it } from "vitest";
import { cards, PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const sent = {
  send: {
    jobId: "job-9",
    agent: PRIMARY,
    sentMessageId: "m-9",
    queued: false,
  },
} as const;

describe("job commands in human mode", () => {
  it("prints only the final reply for a done ask", async () => {
    const outcome = {
      status: "done",
      finalReply: "RESULT: PONG\n",
      replies: [],
    } as const;
    const run = await runCli(["ask", "ping", "--agent", "Primary Test"], {
      outputs: { ask: { jobId: "job-1", agent: PRIMARY, outcome } },
    });
    expect(run).toMatchObject({
      stdout: "RESULT: PONG\n",
      stderr: "",
      code: 0,
    });
  });

  it("prints the job id on stdout and the resume hint on stderr when pending", async () => {
    const reason =
      "no Done verdict within 30000 ms (last: running, target-active)";
    const outcome = { status: "pending", reason } as const;
    const run = await runCli(["ask", "ping"], {
      outputs: { ask: { jobId: "job-4", agent: PRIMARY, outcome } },
    });
    expect(run).toMatchObject({
      stdout: "job-4\n",
      stderr: lines(
        `Not done yet: ${reason}`,
        "Resume with: grokbot wait job-4",
      ),
      code: 4,
    });
  });

  it("names every open card and says which only the owner can answer", async () => {
    const outcome = {
      status: "awaiting-approval",
      reason: "auto-review-approval",
      cards: cards(["auto-review-approval", "secret-request"]),
    } as const;
    const run = await runCli(["wait", "job-3"], {
      outputs: { wait: { jobId: "job-3", agentId: PRIMARY.agentId, outcome } },
    });
    expect(run).toMatchObject({
      stdout: lines(
        "Awaiting approval: auto-review-approval",
        "Open cards: auto-review-approval (Approval needed), secret-request (Secret requested)",
      ),
      stderr:
        "To continue, run grokbot approve --yes or grokbot deny --yes; only the owner can answer this in the GrokBot app (secret-request). Then resume with: grokbot wait job-3\n",
      code: 3,
    });
  });

  it("names a box hand-off as a step only the owner can take", async () => {
    const outcome = {
      status: "awaiting-approval",
      reason: "Take over the bot's computer: Sign in to Xero",
      cards: [],
      handoff: { requestId: "h-1", instruction: "Sign in to Xero" },
    } as const;
    const run = await runCli(["wait", "job-5"], {
      outputs: { wait: { jobId: "job-5", agentId: PRIMARY.agentId, outcome } },
    });
    expect(run).toMatchObject({
      stdout:
        "Awaiting approval: Take over the bot's computer: Sign in to Xero\n",
      stderr:
        "To continue, only the owner can answer this in the GrokBot app (box hand-off). Then resume with: grokbot wait job-5\n",
      code: 3,
    });
  });

  it("points a widget at grokbot answer", async () => {
    const outcome = {
      status: "awaiting-approval",
      reason: "Which color do you pick?",
      cards: cards(["widget"]),
    } as const;
    const run = await runCli(["wait", "job-4"], {
      outputs: { wait: { jobId: "job-4", agentId: PRIMARY.agentId, outcome } },
    });
    expect(run.stderr).toBe(
      "To continue, answer it with: grokbot answer <value> (see grokbot approvals). Then resume with: grokbot wait job-4\n",
    );
    expect(run.code).toBe(3);
  });

  it("prints every reply of a shared run and flags it on stderr with exit 5", async () => {
    const outcome = {
      status: "ambiguous",
      reason:
        "the bot may have answered this message in one run together with message #171",
      replyText: "Starting A.\n\nRESULT B\n\nRESULT A",
      replies: [],
    } as const;
    const run = await runCli(["wait", "job-2"], {
      outputs: {
        wait: {
          jobId: "job-2",
          agentId: PRIMARY.agentId,
          agentName: "Primary Test",
          outcome,
        },
      },
    });
    expect(run).toMatchObject({
      stdout: lines("Starting A.", "", "RESULT B", "", "RESULT A"),
      stderr:
        "Ambiguous: the bot may have answered this message in one run together with message #171. stdout has every reply of that run, in order; check which one answers job job-2.\n",
      code: 5,
    });
  });

  it("prints the job id for send", async () => {
    const run = await runCli(["send", "build it"], { outputs: sent });
    expect(run).toMatchObject({
      stdout: "job-9\n",
      stderr: "Sent to Primary Test. Get the reply with: grokbot wait job-9\n",
      code: 0,
    });
  });

  it("says a queued send goes out once the bot is free", async () => {
    const queued = { send: { ...sent.send, queued: true } };
    const run = await runCli(["send", "build it"], { outputs: queued });
    expect(run).toMatchObject({
      stdout: "job-9\n",
      stderr:
        "Queued for Primary Test: it is busy, so the message goes out once it is free. Send it and get the reply with: grokbot wait job-9\n",
      code: 0,
    });
  });
});

describe("--json output", () => {
  it("prints exactly one JSON document and nothing on stderr", async () => {
    const run = await runCli(["send", "build it", "--json"], { outputs: sent });
    expect(JSON.parse(run.stdout)).toEqual({
      jobId: "job-9",
      agent: {
        kind: "agent",
        agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09",
        rowId: "11",
        name: "Primary Test",
        title: "",
        description: "",
        harness: "temporal",
      },
      sentMessageId: "m-9",
      queued: false,
    });
    expect(run).toMatchObject({ stderr: "", code: 0 });
  });

  it.each([
    [{ status: "pending", reason: "timed out" }, 4],
    [{ status: "awaiting-approval", reason: "connector", cards: [] }, 3],
    [{ status: "ambiguous", reason: "shared", replyText: "A", replies: [] }, 5],
  ] as const)(
    "keeps exit codes without human hints for %j",
    async (outcome, code) => {
      const run = await runCli(["ask", "ping", "--json"], {
        outputs: { ask: { jobId: "job-4", agent: PRIMARY, outcome } },
      });
      expect(JSON.parse(run.stdout).outcome).toEqual(outcome);
      expect(run).toMatchObject({ stderr: "", code });
    },
  );
});
