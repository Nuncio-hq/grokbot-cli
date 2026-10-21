import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const item = {
  id: "mine0001",
  kind: "question",
  severity: "normal",
  project: "Acme Web",
  title: "Which database?",
  bot: { agentId: PRIMARY.agentId, name: "Primary Test" },
  doneWhen: "a choice is made",
  choices: ["a", "b"],
} as const;
const watching = { session: "omp:me000001", jobs: [] };

describe("grokbot inbox wait", () => {
  it("runs the catalog command, with every --job and the default timeout", async () => {
    const run = await runCli(
      ["inbox", "wait", "--job", "1f2e3d4c", "--job", "5a6b7c8d"],
      {
        outputs: {
          "inbox-wait": {
            items: [],
            timedOut: true,
            waitedSeconds: 540,
            watching,
          },
        },
      },
    );
    expect(run.calls).toEqual([
      {
        name: "inbox-wait",
        input: {
          job: ["1f2e3d4c", "5a6b7c8d"],
          timeout: "9m",
          json: false,
        },
        signal: expect.anything(),
      },
    ]);
  });

  it("prints the items that arrived and exits 0", async () => {
    const run = await runCli(["inbox", "wait"], {
      outputs: {
        "inbox-wait": {
          items: [item],
          timedOut: false,
          waitedSeconds: 3,
          watching,
        },
      },
    });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(
      "mine0001 · question · normal · Acme Web · Primary Test · Which database?",
    );
    expect(run.stdout).toContain(
      "asks: done when: a choice is made; choices: a | b",
    );
    expect(run.stdout).toContain("next: grokbot inbox-show mine0001");
  });

  it("exits 4 with a one-line message when nothing came before the timeout", async () => {
    const run = await runCli(["inbox", "wait", "--timeout", "30s"], {
      outputs: {
        "inbox-wait": {
          items: [],
          timedOut: true,
          waitedSeconds: 30,
          watching,
        },
      },
    });
    expect(run).toMatchObject({
      stdout: "",
      stderr:
        "Nothing yet for this session or its jobs; run grokbot inbox wait again.\n",
      code: 4,
    });
  });

  it("is help-able as two words", async () => {
    const run = await runCli(["inbox", "wait", "--help"]);
    expect(run.stdout).toContain("Usage: grokbot inbox wait");
    expect(run.code).toBe(0);
  });
});

describe("grokbot inbox check", () => {
  it("exits 0 and prints nothing when nothing is new", async () => {
    const run = await runCli(["inbox", "check"], {
      outputs: { "inbox-check": { items: [] } },
    });
    expect(run).toMatchObject({ stdout: "", stderr: "", code: 0 });
  });

  it("prints the items to stderr and exits 2", async () => {
    const run = await runCli(["inbox", "check"], {
      outputs: { "inbox-check": { items: [item] } },
    });
    expect(run.stdout).toBe("");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Read each before you stop");
    expect(run.stderr).toContain("next: grokbot inbox-show mine0001");
  });

  it("explains in its help that a runtime hook runs it before the agent stops", async () => {
    const run = await runCli(["inbox", "check", "--help"]);
    expect(run.stdout).toContain("before the agent stops");
    expect(run.stdout).toContain("exit 2");
  });
});

describe("catch-up notice and next-step hint in the CLI", () => {
  const agents = { agents: [PRIMARY] };

  it("prints the notice after the normal output, on stderr", async () => {
    const run = await runCli(["agents"], {
      outputs: { agents: { ...agents, inboxNotice: { items: [item] } } },
    });
    expect(run.stdout).toContain("Primary Test");
    expect(run.stderr).toContain("Inbox: 1 open inbox item for this session");
    expect(run.stderr).toContain("mine0001");
    expect(run.stderr).toContain("grokbot inbox-show mine0001");
  });

  it("leaves it in the JSON document, not on stderr, under --json", async () => {
    const run = await runCli(["agents", "--json"], {
      outputs: { agents: { ...agents, inboxNotice: { items: [item] } } },
    });
    expect(JSON.parse(run.stdout).inboxNotice.items[0].id).toBe("mine0001");
    expect(run.stderr).toBe("");
  });

  it("adds no notice when there is none", async () => {
    const run = await runCli(["agents"], { outputs: { agents } });
    expect(run.stderr).toBe("");
  });

  it("prints the next step after a message that is not settled, and keeps it in the JSON", async () => {
    const outcome = { status: "pending", reason: "timed out" } as const;
    const next = "Wait for the answer with `grokbot wait job-4`.";
    const output = { jobId: "job-4", agent: PRIMARY, outcome, next };
    const human = await runCli(["ask", "ping"], { outputs: { ask: output } });
    expect(human.stderr.endsWith(`Next: ${next}\n`)).toBe(true);
    const json = await runCli(["ask", "ping", "--json"], {
      outputs: { ask: output },
    });
    expect(JSON.parse(json.stdout).next).toBe(next);
  });

  it("prints no next step for a settled answer", async () => {
    const outcome = { status: "done", finalReply: "OK", replies: [] } as const;
    const run = await runCli(["ask", "ping"], {
      outputs: { ask: { jobId: "job-4", agent: PRIMARY, outcome } },
    });
    expect(run.stderr).toBe("");
  });
});
