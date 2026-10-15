import { GrokBotError } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const doneAsk = {
  ask: {
    jobId: "job-1",
    agent: PRIMARY,
    outcome: { status: "done", finalReply: "PONG", replies: [] },
  },
} as const;
const dispatched = {
  type: "dispatched",
  jobId: "job-1",
  agentId: PRIMARY.agentId,
} as const;

describe("runtime errors", () => {
  it.each([
    [
      new GrokBotError("auth", "Cannot read the Keychain item."),
      "grokbot: Cannot read the Keychain item.\nRun grokbot login, or open the Grok Bot app once (logged in), then retry.\n",
      1,
    ],
    [
      new GrokBotError(
        "not-found",
        'No agent matches "Ghost". Available agents: Primary Test.',
      ),
      'grokbot: No agent matches "Ghost". Available agents: Primary Test.\n',
      1,
    ],
    [
      new GrokBotError(
        "ambiguous",
        '"Test" matches 2 agents. Pass the full agentId.',
      ),
      'grokbot: "Test" matches 2 agents. Pass the full agentId.\n',
      1,
    ],
    [
      new GrokBotError("http", "SendGrokBotUserMessage failed with HTTP 502"),
      "grokbot: SendGrokBotUserMessage failed with HTTP 502\n",
      1,
    ],
    [
      new TypeError("fetch failed"),
      "grokbot: unexpected error: fetch failed\n",
      1,
    ],
  ])("maps %s", async (error, stderr, code) => {
    const run = await runCli(["ask", "hi"], { error });
    expect(run).toMatchObject({ stdout: "", stderr, code });
  });

  it("reports a runner that cannot be built, like the Wave 2A stub", async () => {
    const run = await runCli(["agents"], {
      createError: new GrokBotError(
        "protocol",
        "createCommandRunner is not implemented yet.",
      ),
    });
    expect(run).toMatchObject({
      stdout: "",
      stderr: "grokbot: createCommandRunner is not implemented yet.\n",
      code: 1,
    });
  });

  it.each([
    [[], "grokbot: interrupted\n"],
    [
      [dispatched],
      "job job-1\ngrokbot: interrupted\nResume with: grokbot wait job-1\n",
    ],
  ] as const)(
    "aborts the run on Ctrl-C and exits 130 after events %j",
    async (events, stderr) => {
      const interrupt = new AbortController();
      const pending = runCli(["ask", "hi"], {
        events,
        hangForever: true,
        signal: interrupt.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      interrupt.abort();
      const run = await pending;
      expect(run).toMatchObject({ stdout: "", stderr, code: 130 });
      expect(run.calls[0]?.signal?.aborted).toBe(true);
    },
  );
});

describe("the dispatched job id", () => {
  it.each([
    [["ask", "hi"], false, "PONG\n"],
    [["ask", "hi"], true, "PONG\n"],
  ] as const)(
    "goes to stderr for %j when tty=%s",
    async (argv, isTTY, stdout) => {
      const run = await runCli(argv, {
        outputs: doneAsk,
        events: [dispatched],
        isTTY,
      });
      expect(run).toMatchObject({ stdout, stderr: "job job-1\n", code: 0 });
    },
  );

  it("goes to stderr with --json, leaving stdout one JSON document", async () => {
    const run = await runCli(["ask", "hi", "--json"], {
      outputs: doneAsk,
      events: [dispatched],
    });
    expect([JSON.parse(run.stdout).jobId, run.stderr, run.code]).toEqual([
      "job-1",
      "job job-1\n",
      0,
    ]);
  });
});

describe("progress", () => {
  const events = [
    {
      type: "verdict",
      verdict: { status: "running", reason: "awaiting-echo" },
    },
    { type: "reconnecting", reason: "stream closed" },
    { type: "stream", event: { type: "heartbeat", serverTimeMs: 1 } },
    {
      type: "verdict",
      verdict: { status: "running", reason: "pending-delegation" },
    },
  ] as const;

  it("goes to stderr when stderr is a TTY", async () => {
    const run = await runCli(["ask", "hi"], {
      outputs: doneAsk,
      events,
      isTTY: true,
    });
    expect(run).toMatchObject({
      stdout: "PONG\n",
      stderr:
        "… waiting for the message echo\n" +
        "… reconnecting: stream closed\n" +
        "… waiting on a delegated agent\n",
      code: 0,
    });
  });

  it.each([
    [["ask", "hi"], false],
    [["ask", "hi", "--json"], true],
  ])("is silent for %j when tty=%s", async (argv, isTTY) => {
    const run = await runCli(argv, { outputs: doneAsk, events, isTTY });
    expect([run.stderr, run.code]).toEqual(["", 0]);
  });
});
