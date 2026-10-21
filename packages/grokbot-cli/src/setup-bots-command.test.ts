import { listCommands } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const NEXT =
  "Show the owner the project list, then close the Setup check item.";
const done = {
  status: "done",
  finalReply: "My projects: Alpha, Beta",
  replies: [],
} as const;
const pending = {
  status: "pending",
  reason: "no Done verdict within 600000 ms (last: running, target-active)",
} as const;

const settled = (outcome: typeof done | typeof pending) => ({
  "setup-bots": { jobId: "job-4", agent: PRIMARY, outcome, next: NEXT },
});

describe("grokbot setup-bots", () => {
  it("runs the catalog command with no text, and ask's flags and defaults", async () => {
    const plain = await runCli(["setup-bots"], { outputs: settled(done) });
    const flagged = await runCli(
      ["setup-bots", "--agent", "Primary Test", "--timeout", "30", "--json"],
      { outputs: settled(done) },
    );
    expect(plain.calls.map(({ name, input }) => ({ name, input }))).toEqual([
      { name: "setup-bots", input: { timeout: 600, json: false } },
    ]);
    expect(flagged.calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "setup-bots",
        input: { timeout: 30, agent: "Primary Test", json: true },
      },
    ]);
  });

  it("prints the bot's reply on stdout and the next steps on stderr, and keeps them in the JSON", async () => {
    const human = await runCli(["setup-bots"], { outputs: settled(done) });
    expect(human).toMatchObject({
      stdout: "My projects: Alpha, Beta\n",
      stderr: `Next: ${NEXT}\n`,
      code: 0,
    });
    const json = await runCli(["setup-bots", "--json"], {
      outputs: settled(done),
    });
    expect(JSON.parse(json.stdout)).toMatchObject({
      jobId: "job-4",
      outcome: done,
      next: NEXT,
    });
  });

  it("exits 4 with the job id on stdout while the reply is not in, still naming the next steps", async () => {
    const run = await runCli(["setup-bots"], { outputs: settled(pending) });
    expect(run).toMatchObject({ stdout: "job-4\n", code: 4 });
    expect(run.stderr).toContain("grokbot wait job-4");
    expect(run.stderr.endsWith(`Next: ${NEXT}\n`)).toBe(true);
  });

  it("takes no text", async () => {
    const run = await runCli(["setup-bots", "hello"], {
      outputs: settled(done),
    });
    expect(run).toMatchObject({ stdout: "", code: 2, calls: [] });
    expect(run.stderr).toContain("Usage: grokbot setup-bots");
  });

  it("is a catalog command with ask's safety tag and RPC methods, with its own help and a row in general help", async () => {
    const commands = listCommands();
    const ask = commands.find((c) => c.name === "ask");
    const setup = commands.find((c) => c.name === "setup-bots");
    expect(setup).toBeDefined();
    expect([setup?.safety, setup?.methods]).toEqual([
      ask?.safety,
      ask?.methods,
    ]);
    const help = await runCli(["setup-bots", "--help"]);
    expect(help).toMatchObject({ code: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: grokbot setup-bots");
    expect(help.stdout).toContain("--agent");
    const general = await runCli(["--help"]);
    expect(general.stdout).toMatch(/^ {2}setup-bots\s+\S/m);
  });
});
