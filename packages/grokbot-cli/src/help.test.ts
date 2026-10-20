import { GROKBOT_VERSION } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { runCli } from "./fixtures/run-cli.js";

const TITLE = `grokbot ${GROKBOT_VERSION}. Orchestrate your GrokBot workforce from any terminal.\n`;
const COMMANDS = "\nCommands:\n";
const PHASE_01_SUMMARIES = [
  ["agents", "List GrokBot agents on the account"],
  ["team", "List agents with live running/idle/awaiting status"],
  ["ask", "Send a prompt and wait until the Done Rule settles"],
  [
    "send",
    "Dispatch a message, or queue it while the bot is busy, and return a resumable job id",
  ],
  ["wait", "Wait for a dispatched job id to finish"],
  ["tail", "Read recent decoded transcript entries"],
  ["interrupt", "Interrupt the active run on an agent"],
] as const;
/** Command lines between the head and the foot, as [name, summary] pairs. */
function commandRows(stdout: string): [string, string][] {
  const body = stdout.slice(
    stdout.indexOf(COMMANDS) + COMMANDS.length,
    stdout.indexOf("\nAccount:"),
  );
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [, name = "", summary = ""] = /^ {2}(\S+)\s+(.*)$/.exec(line) ?? [];
      return [name, summary];
    });
}

const TAIL_HELP = [
  "Read recent decoded transcript entries",
  "",
  "Usage: grokbot tail [-n <integer>] [--agent <string>] [--json]",
  "",
  "Flags:",
  "  -n, --limit <integer>  Number of recent entries to read (default: 15, min: 1)",
  "  --json                 Return machine-readable JSON (default: false)",
  "",
].join("\n");

const ASK_HELP = [
  "Send a prompt and wait until the Done Rule settles",
  "",
  "Usage: grokbot ask <text> [--timeout <integer>] [--agent <string>] [--json]",
  "",
  "Arguments:",
  "  <text>  Message to send to the agent (required)",
  "",
  "Flags:",
  "  --timeout <integer>  Seconds to wait before giving up (default: 600, min: 1)",
  "  --json               Return machine-readable JSON (default: false)",
  "",
].join("\n");

/** The --agent description is wording that changes with the default order; compare the rest. */
const withoutAgentLine = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^ {2}--agent <string>/.test(line))
    .join("\n");

describe("help and version never build the runner", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])(
    "%j prints general help",
    async (argv) => {
      const run = await runCli(argv);
      expect(run).toMatchObject({ stderr: "", code: 0 });
      expect(run.stdout.startsWith(TITLE)).toBe(true);
      expect(run.stdout).toContain(
        "Usage: grokbot <command> [arguments] [flags]",
      );
      // A first-time user finds setup-prompt before the long command list.
      expect(run.stdout.indexOf("grokbot setup-prompt")).toBeLessThan(
        run.stdout.indexOf(COMMANDS),
      );
      expect(commandRows(run.stdout).slice(0, 7)).toEqual(PHASE_01_SUMMARIES);
      expect(run.runnerOptions).toEqual([]);
    },
  );

  it.each([
    [["tail", "--help"]],
    [["help", "tail"]],
    [["--help", "tail", "-n", "x"]],
  ])("%j prints tail help", async (argv) => {
    const run = await runCli(argv);
    expect(run).toMatchObject({ stderr: "", code: 0 });
    expect(withoutAgentLine(run.stdout)).toBe(TAIL_HELP);
    expect(run.runnerOptions).toEqual([]);
  });

  it("renders the positional and its required marker", async () => {
    const run = await runCli(["ask", "-h"]);
    expect(withoutAgentLine(run.stdout)).toBe(ASK_HELP);
  });

  it("help for an unknown topic is a usage error", async () => {
    const run = await runCli(["help", "deploy"]);
    expect(run.stderr).toBe(
      'grokbot: unknown command "deploy"\n' +
        "Usage: grokbot <command> [arguments] [flags] (grokbot --help lists the commands)\n",
    );
    expect(run.code).toBe(2);
  });

  it.each([[["--version"]], [["-v"]], [["tail", "--version"]]])(
    "%j prints the version",
    async (argv) => {
      const run = await runCli(argv);
      expect(run).toMatchObject({
        stdout: `${GROKBOT_VERSION}\n`,
        stderr: "",
        code: 0,
      });
    },
  );
});
