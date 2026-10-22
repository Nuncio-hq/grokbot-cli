import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { type CliRun, runCli } from "./fixtures/run-cli.js";

const done = {
  reply: {
    jobId: "job-2",
    agent: PRIMARY,
    replyToId: "t5s2",
    outcome: { status: "done", finalReply: "Got it.\n", replies: [] },
  },
} as const;

const inputOf = (run: CliRun) =>
  run.calls.map(({ name, input }) => ({ name, input }));

describe("grokbot reply arguments", () => {
  it("takes a job, then the text", async () => {
    const run = await runCli(["reply", "job-1", "Yes, the second one"], {
      outputs: done,
    });
    expect(inputOf(run)).toEqual([
      {
        name: "reply",
        input: {
          job: "job-1",
          text: "Yes, the second one",
          timeout: 600,
          now: false,
          json: false,
        },
      },
    ]);
  });

  it("takes --to and --timeout with a job", async () => {
    const run = await runCli(
      ["reply", "job-1", "About this one", "--to", "t4s1", "--timeout", "30"],
      { outputs: done },
    );
    expect(run.calls[0]?.input).toEqual({
      job: "job-1",
      text: "About this one",
      to: "t4s1",
      timeout: 30,
      now: false,
      json: false,
    });
  });

  it("takes the text alone with --to and --agent, and no job", async () => {
    const run = await runCli(
      ["reply", "Looks good", "--to", "t4s1", "--agent", "Primary Test"],
      { outputs: done },
    );
    expect(run.calls[0]?.input).toEqual({
      text: "Looks good",
      to: "t4s1",
      agent: "Primary Test",
      timeout: 600,
      now: false,
      json: false,
    });
  });

  it("takes --quote with the entry it quotes", async () => {
    const run = await runCli(
      ["reply", "job-1", "Yes", "--to", "t4s1", "--quote", "the second option"],
      { outputs: done },
    );
    expect(run.calls[0]?.input).toEqual({
      job: "job-1",
      text: "Yes",
      to: "t4s1",
      quote: "the second option",
      timeout: 600,
      now: false,
      json: false,
    });
  });

  it("keeps a dashed text after --", async () => {
    const run = await runCli(["reply", "job-1", "--", "-5 is my answer"], {
      outputs: done,
    });
    expect(run.calls[0]?.input).toMatchObject({
      job: "job-1",
      text: "-5 is my answer",
    });
  });

  it.each([
    [["reply"]],
    [["reply", "--to", "t4s1"]],
    [["reply", "job-1", "text", "extra"]],
  ])("%j is a usage error and never calls the runner", async (argv) => {
    const run = await runCli(argv, { outputs: done });
    expect([run.code, run.calls]).toEqual([2, []]);
  });
});

describe("grokbot reply output", () => {
  it("prints the final reply and exits 0 when done, like ask", async () => {
    const run = await runCli(["reply", "job-1", "yes"], { outputs: done });
    expect(run).toMatchObject({ stdout: "Got it.\n", stderr: "", code: 0 });
  });

  it("puts the job id on stderr as soon as the reply is sent", async () => {
    const run = await runCli(["reply", "job-1", "yes"], {
      outputs: done,
      events: [
        { type: "dispatched", jobId: "job-2", agentId: PRIMARY.agentId },
      ],
    });
    expect([run.stderr, run.code]).toEqual(["job job-2\n", 0]);
  });

  it("exits 4 with the job id on stdout while the reply waits", async () => {
    const run = await runCli(["reply", "job-1", "yes"], {
      outputs: {
        reply: {
          ...done.reply,
          outcome: { status: "pending", reason: "queued", queued: true },
        },
      },
    });
    expect([run.stdout, run.code]).toEqual(["job-2\n", 4]);
    expect(run.stderr).toContain("grokbot wait job-2");
  });

  it("prints the full result with --json", async () => {
    const run = await runCli(["reply", "job-1", "yes", "--json"], {
      outputs: done,
    });
    expect(JSON.parse(run.stdout)).toMatchObject({
      jobId: "job-2",
      replyToId: "t5s2",
      outcome: { status: "done" },
    });
  });
});

describe("grokbot reply help", () => {
  it("shows the job as optional and the text as required", async () => {
    const run = await runCli(["reply", "--help"]);
    expect(run.stdout).toContain(
      "Usage: grokbot reply [job] <text> [--to <string>]",
    );
  });
});
