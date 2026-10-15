import { describe, expect, it } from "vitest";
import { runCli } from "./fixtures/run-cli.js";

const HELP_HEAD = [
  "grokbot 0.0.1. Orchestrate your GrokBot workforce from any terminal.",
  "",
  "Usage: grokbot <command> [arguments] [flags]",
  "",
  "Commands:",
  "",
].join("\n");
const PHASE_01_SUMMARIES = [
  ["agents", "List GrokBot agents on the account"],
  ["team", "List agents with live running/idle/awaiting status"],
  ["ask", "Send a prompt and wait until the Done Rule settles"],
  ["send", "Dispatch a message and return a resumable job id"],
  ["wait", "Wait for a dispatched job id to finish"],
  ["tail", "Read recent decoded transcript entries"],
  ["interrupt", "Interrupt the active run on an agent"],
] as const;
const HELP_FOOT = [
  "",
  "Flags go before or after the command. Commands with an --agent flag fall",
  "back to GROKBOT_AGENT. Workforce commands (update, fire, room-members,",
  "skills-*, routines-*) take the bot as their first argument instead.",
  'Put -- before text that starts with a dash: grokbot ask -- "-5 is my answer"',
  "With --json, stdout is one JSON document; the job id and errors still go",
  "to stderr as plain text.",
  "Run grokbot <command> --help for its arguments, grokbot --version for the version.",
  "",
].join("\n");

/** Command lines between the head and the foot, as [name, summary] pairs. */
function commandRows(stdout: string): [string, string][] {
  const body = stdout.slice(HELP_HEAD.length, stdout.length - HELP_FOOT.length);
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
  "  --agent <string>       Agent name, slug, or agentId (defaults to GROKBOT_AGENT)",
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
  "  --agent <string>     Agent name, slug, or agentId (defaults to GROKBOT_AGENT)",
  "  --json               Return machine-readable JSON (default: false)",
  "",
].join("\n");

describe("help and version never build the runner", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])(
    "%j prints general help",
    async (argv) => {
      const run = await runCli(argv);
      expect(run).toMatchObject({ stderr: "", code: 0 });
      expect(run.stdout.startsWith(HELP_HEAD)).toBe(true);
      expect(run.stdout.endsWith(HELP_FOOT)).toBe(true);
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
    expect(run).toMatchObject({ stdout: TAIL_HELP, stderr: "", code: 0 });
    expect(run.runnerOptions).toEqual([]);
  });

  it("renders the positional and its required marker", async () => {
    const run = await runCli(["ask", "-h"]);
    expect(run.stdout).toBe(ASK_HELP);
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
      expect(run).toMatchObject({ stdout: "0.0.1\n", stderr: "", code: 0 });
    },
  );
});
