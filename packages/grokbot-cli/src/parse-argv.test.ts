import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const ASK_USAGE =
  "Usage: grokbot ask <text> [--timeout <integer>] [--now] [--agent <string>] [--json]\n";
const TAIL_USAGE =
  "Usage: grokbot tail [-n <integer>] [--agent <string>] [--json]\n";
const GENERAL_USAGE =
  "Usage: grokbot <command> [arguments] [flags] (grokbot --help lists the commands)\n";
const DASH_HINT = " (put -- before text that starts with a dash)";

const tailOutput = { tail: { agent: PRIMARY, entries: [] } };
const doneAsk = {
  ask: {
    jobId: "job-1",
    agent: PRIMARY,
    outcome: { status: "done", finalReply: "PONG", replies: [] },
  },
} as const;

describe("argv parsing", () => {
  it("accepts flags after the positional text", async () => {
    const run = await runCli(
      ["ask", "hi", "--agent", "Primary Test", "--json"],
      { outputs: doneAsk },
    );
    expect(run.calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "ask",
        input: {
          text: "hi",
          timeout: 600,
          now: false,
          agent: "Primary Test",
          json: true,
        },
      },
    ]);
    expect(run.code).toBe(0);
  });

  it("accepts flags before the command and --name=value", async () => {
    const run = await runCli(
      ["--agent=Staff Test", "--timeout", "30", "ask", "hello there"],
      { outputs: doneAsk },
    );
    expect(run.calls[0]?.input).toEqual({
      text: "hello there",
      timeout: 30,
      now: false,
      agent: "Staff Test",
      json: false,
    });
  });

  it("maps -n to the limit param", async () => {
    const run = await runCli(["tail", "-n", "5"], { outputs: tailOutput });
    expect(run.calls[0]?.input).toEqual({ limit: 5, json: false });
  });

  it("treats every token after -- as a positional", async () => {
    const run = await runCli(["ask", "--", "--json is literal text"], {
      outputs: doneAsk,
    });
    expect(run.calls[0]?.input).toEqual({
      text: "--json is literal text",
      timeout: 600,
      now: false,
      json: false,
    });
  });

  it("passes GROKBOT_AGENT to the runner as defaultAgent", async () => {
    const run = await runCli(["tail"], {
      outputs: tailOutput,
      env: { GROKBOT_AGENT: "Primary Test" },
    });
    expect(run.runnerOptions).toEqual([{ defaultAgent: "Primary Test" }]);
    expect(run.calls[0]?.input).toEqual({ limit: 15, json: false });
  });

  it("creates the runner without defaultAgent when GROKBOT_AGENT is blank", async () => {
    const run = await runCli(["tail"], {
      outputs: tailOutput,
      env: { GROKBOT_AGENT: "  " },
    });
    expect(run.runnerOptions).toEqual([{}]);
  });
});

describe("usage errors exit 2 and never build the runner", () => {
  const cases: readonly (readonly [string[], string])[] = [
    [
      ["ask", "hi", "--bogus"],
      `grokbot: ask: unknown flag --bogus${DASH_HINT}\n${ASK_USAGE}`,
    ],
    [
      ["send", "-5 degrees outside"],
      `grokbot: send: unknown flag -5 degrees outside${DASH_HINT}\n` +
        "Usage: grokbot send <text> [--now] [--agent <string>] [--json]\n",
    ],
    [["tail", "-x"], `grokbot: tail: unknown flag -x\n${TAIL_USAGE}`],
    [
      ["wait", "-x"],
      "grokbot: wait: unknown flag -x\n" +
        "Usage: grokbot wait <job> [--timeout <integer>] [--json]\n",
    ],
    [
      ["ask", "-n", "5", "hi"],
      `grokbot: ask: unknown flag -n${DASH_HINT}\n${ASK_USAGE}`,
    ],
    [
      ["ask", "--json"],
      `grokbot: ask: missing required argument <text>\n${ASK_USAGE}`,
    ],
    [
      ["ask", "hello", "there"],
      `grokbot: ask: unexpected argument "there"\n${ASK_USAGE}`,
    ],
    [
      ["tail", "-n", "0"],
      `grokbot: tail: flag --limit must be at least 1, got "0"\n${TAIL_USAGE}`,
    ],
    [
      ["tail", "-n", "five"],
      `grokbot: tail: flag --limit must be an integer, got "five"\n${TAIL_USAGE}`,
    ],
    [
      ["tail", "--agent"],
      `grokbot: tail: --agent needs a value\n${TAIL_USAGE}`,
    ],
    [
      ["tail", "--agent", "--json"],
      `grokbot: tail: --agent needs a value\n${TAIL_USAGE}`,
    ],
    [
      ["tail", "--json=yes"],
      `grokbot: tail: --json does not take a value\n${TAIL_USAGE}`,
    ],
    [["deploy"], `grokbot: unknown command "deploy"\n${GENERAL_USAGE}`],
    [["--json"], `grokbot: missing command\n${GENERAL_USAGE}`],
    [
      ["ask", "--timeout", "0", "--bogus"],
      `grokbot: ask: unknown flag --bogus${DASH_HINT}\n${ASK_USAGE}`,
    ],
  ];

  it.each(cases)("%j", async (argv, stderr) => {
    const run = await runCli(argv, { outputs: doneAsk });
    expect({ stdout: run.stdout, stderr: run.stderr, code: run.code }).toEqual({
      stdout: "",
      stderr,
      code: 2,
    });
    expect(run.runnerOptions).toEqual([]);
  });

  it("reports every catalog error before the usage line", async () => {
    const run = await runCli(["ask", "--timeout", "0"]);
    expect(run.stderr).toBe(
      "grokbot: ask: missing required argument <text>\n" +
        `grokbot: ask: flag --timeout must be at least 1, got "0"\n${ASK_USAGE}`,
    );
    expect(run.code).toBe(2);
  });
});
