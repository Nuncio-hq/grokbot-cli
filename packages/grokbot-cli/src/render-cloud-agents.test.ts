import type { CommandOutputs } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { runCli } from "./fixtures/run-cli.js";

const BC = "bc-00000000-0000-4000-8000-0000000000a1";
const REPO = "https://example.test/acme/widgets";
type Summary = CommandOutputs["cloud-agents"]["cloudAgents"][number];
type Detail = CommandOutputs["cloud-agent"]["cloudAgent"];

const summary = (over: Partial<Summary> = {}): Summary => ({
  bcId: BC,
  name: "Fix the flaky test",
  status: "finished",
  repo: REPO,
  branch: "cursor/fix-flaky",
  prStatus: "merged",
  prUrl: `${REPO}/pull/7`,
  updatedAtMs: Date.UTC(2026, 9, 19, 14, 30),
  createdAtMs: null,
  lastActivityAtMs: null,
  needsYou: false,
  ...over,
});
const detail = (over: Partial<Detail> = {}): Detail => ({
  ...summary(),
  baseBranch: "main",
  linesAdded: 120,
  linesRemoved: 8,
  filesChanged: 5,
  model: { name: "example-model", maxMode: true },
  source: "grok_bot",
  ...over,
});
const listing = (
  over: Partial<CommandOutputs["cloud-agents"]> = {},
): CommandOutputs["cloud-agents"] => ({
  cloudAgents: [summary()],
  hasMore: false,
  launchedBy: null,
  ...over,
});
const shown = (
  over: Partial<CommandOutputs["cloud-agent"]> = {},
): CommandOutputs["cloud-agent"] => ({
  cloudAgent: detail(),
  messages: [],
  messageCount: null,
  ...over,
});

describe("cloud-agents in human mode", () => {
  it("prints one row per agent with its status, repo, branch, pull request and update time", async () => {
    const run = await runCli(["cloud-agents"], {
      outputs: {
        "cloud-agents": listing({
          cloudAgents: [
            summary(),
            summary({
              bcId: "bc-b2",
              name: "",
              status: "running",
              repo: "",
              branch: "",
              prStatus: null,
              updatedAtMs: null,
            }),
          ],
        }),
      },
    });
    expect([run.stdout, run.stderr, run.code]).toEqual([
      "ID                                       NAME                STATUS    REPO                               BRANCH            PR      UPDATED (UTC)\n" +
        `${BC}  Fix the flaky test  finished  ${REPO}  cursor/fix-flaky  merged  2026-10-19T14:30\n` +
        "bc-b2                                    -                   running   -                                  -                 -       -\n",
      "",
      0,
    ]);
  });

  it("passes --limit and --agent to the command", async () => {
    const run = await runCli(
      ["cloud-agents", "--limit", "7", "--agent", "Primary Test"],
      { outputs: { "cloud-agents": listing() } },
    );
    expect(run.calls[0]?.input).toEqual({
      limit: 7,
      agent: "Primary Test",
      json: false,
    });
  });

  it("says when there is nothing to list, and when a bot launched nothing", async () => {
    const empty = await runCli(["cloud-agents"], {
      outputs: { "cloud-agents": listing({ cloudAgents: [] }) },
    });
    const filtered = await runCli(["cloud-agents", "--agent", "Staff Test"], {
      outputs: {
        "cloud-agents": listing({
          cloudAgents: [],
          launchedBy: { agentId: "a-1", name: "Staff Test" },
        }),
      },
    });
    expect(empty.stdout).toMatch(/no cloud agents/i);
    expect(filtered.stdout).toMatch(/no cloud agents/i);
    expect(filtered.stdout).toContain("Staff Test");
    expect(empty.stdout).not.toContain("Staff Test");
  });

  it("marks the agents that wait on the user in the list, and keeps the flag in --json", async () => {
    const output = listing({
      cloudAgents: [summary({ needsYou: true }), summary({ bcId: "bc-b2" })],
    });
    const human = await runCli(["cloud-agents"], {
      outputs: { "cloud-agents": output },
    });
    const rows = human.stdout.trimEnd().split("\n").slice(1);
    expect(rows[0]).toContain("needs you");
    expect(rows[1]).not.toContain("needs you");
    const json = await runCli(["cloud-agents", "--json"], {
      outputs: { "cloud-agents": output },
    });
    expect(
      JSON.parse(json.stdout).cloudAgents.map(
        (a: { needsYou: boolean }) => a.needsYou,
      ),
    ).toEqual([true, false]);
  });

  it("tells on stderr when more agents exist than were listed", async () => {
    const run = await runCli(["cloud-agents"], {
      outputs: { "cloud-agents": listing({ hasMore: true }) },
    });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("--limit");
    expect(run.stdout).not.toContain("--limit");
  });

  it("rejects a limit below 1 as a usage error", async () => {
    const run = await runCli(["cloud-agents", "--limit", "0"]);
    expect([run.code, run.calls]).toEqual([2, []]);
  });

  it("prints the output as JSON under --json", async () => {
    const output = listing();
    const run = await runCli(["cloud-agents", "--json"], {
      outputs: { "cloud-agents": output },
    });
    expect(JSON.parse(run.stdout)).toEqual(output);
  });
});

describe("cloud-agent in human mode", () => {
  it("prints the facts, then the messages with their roles", async () => {
    const run = await runCli(["cloud-agent", BC], {
      outputs: {
        "cloud-agent": shown({
          messages: [
            { id: "b1", role: "human", text: "Fix the flaky test\n" },
            { id: "b2", role: "assistant", text: "Done: it was a race." },
          ],
          messageCount: 2,
        }),
      },
    });
    expect([run.stdout, run.stderr, run.code]).toEqual([
      `Agent:   Fix the flaky test (${BC})\n` +
        "Status:  finished\n" +
        `Repo:    ${REPO}\n` +
        "Branch:  cursor/fix-flaky -> main\n" +
        `PR:      merged ${REPO}/pull/7\n` +
        "Changes: 5 files, +120 -8\n" +
        "Model:   example-model (max mode)\n" +
        "Source:  grok_bot\n" +
        "Updated: 2026-10-19T14:30 UTC\n" +
        "\n2 messages:\n\n" +
        "[human]\nFix the flaky test\n\n" +
        "[assistant]\nDone: it was a race.\n",
      "",
      0,
    ]);
  });

  it("leaves out facts the agent does not have, and says when there are no messages yet", async () => {
    const run = await runCli(["cloud-agent", BC], {
      outputs: {
        "cloud-agent": shown({
          cloudAgent: detail({
            name: "",
            status: "creating",
            repo: "",
            branch: "",
            baseBranch: "",
            prStatus: null,
            prUrl: "",
            linesAdded: 0,
            linesRemoved: 0,
            filesChanged: 0,
            model: null,
            source: "",
            updatedAtMs: null,
          }),
          messageCount: 0,
        }),
      },
    });
    expect(run.stdout).toBe(
      `Agent:   (unnamed) (${BC})\nStatus:  creating\n\nNo messages yet.\n`,
    );
  });

  it("says how many of the messages it shows", async () => {
    const run = await runCli(["cloud-agent", BC, "--messages", "1"], {
      outputs: {
        "cloud-agent": shown({
          messages: [{ id: "b3", role: "assistant", text: "last" }],
          messageCount: 3,
        }),
      },
    });
    expect(run.stdout).toContain(
      "Last 1 of 3 messages:\n\n[assistant]\nlast\n",
    );
    expect(run.calls[0]?.input).toEqual({
      bcId: BC,
      messages: 1,
      wait: false,
      timeout: 600,
      json: false,
    });
  });

  it("prints no message section for --messages 0", async () => {
    const run = await runCli(["cloud-agent", BC, "--messages", "0"], {
      outputs: { "cloud-agent": shown() },
    });
    expect(run.stdout).not.toContain("message");
  });

  it("requires the id", async () => {
    const run = await runCli(["cloud-agent"]);
    expect([run.code, run.calls, run.stderr.split("\n")[0]]).toEqual([
      2,
      [],
      "grokbot: cloud-agent: missing required argument <bcId>",
    ]);
  });
});

describe("cloud-agent --wait exit codes", () => {
  const waited = (outcome: CommandOutputs["cloud-agent"]["outcome"]) =>
    runCli(["cloud-agent", BC, "--wait", "--timeout", "30"], {
      outputs: { "cloud-agent": shown({ outcome }) },
    });

  it("exits 0 once the agent has stopped running, and passes --wait and --timeout on", async () => {
    const run = await waited({ status: "done" });
    expect([run.code, run.stderr, run.calls[0]?.input]).toEqual([
      0,
      "",
      { bcId: BC, messages: 10, wait: true, timeout: 30, json: false },
    ]);
  });

  it("exits 4 when the timeout came first, and says so on stderr", async () => {
    const run = await waited({
      status: "pending",
      reason: "still running after 30 s",
    });
    expect(run.code).toBe(4);
    expect(run.stderr).toContain("still running after 30 s");
    expect(run.stderr).toContain("--wait");
    // The facts still reach stdout, so a caller sees where the agent stands.
    expect(run.stdout).toContain("Status:  finished");
  });

  it("exits 3, the awaiting exit code, when the agent waits on the user, and says for what on stderr", async () => {
    const run = await waited({
      status: "needs-you",
      reason: "waiting for your approval (mcp_tool): Allow the deploy tool",
      approval: {
        id: "ap-1",
        kind: "mcp_tool",
        headline: "Allow the deploy tool",
        operation: "call",
        target: "deploy",
        expiresAtMs: null,
      },
    });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("Allow the deploy tool");
    expect(run.stderr).toContain("--wait");
    expect(run.stdout).toContain("Status:  finished");
  });

  it("exits 3 under --json too, with the outcome and approval in the document", async () => {
    const approval = {
      id: "ap-1",
      kind: "mcp_tool",
      headline: "Allow the deploy tool",
      operation: "call",
      target: "deploy",
      expiresAtMs: 1_790_000_900_000,
    };
    const outcome = {
      status: "needs-you" as const,
      reason: "waiting for your approval",
      approval,
    };
    const run = await runCli(["cloud-agent", BC, "--wait", "--json"], {
      outputs: { "cloud-agent": shown({ outcome }) },
    });
    expect([run.code, JSON.parse(run.stdout).outcome]).toEqual([3, outcome]);
  });

  it("shows that the agent waits on the user among the facts, also without --wait", async () => {
    const run = await runCli(["cloud-agent", BC], {
      outputs: {
        "cloud-agent": shown({ cloudAgent: detail({ needsYou: true }) }),
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^Waiting: +for you$/m);
  });

  it("leaves the waiting line out for an agent that does not wait on the user", async () => {
    const run = await runCli(["cloud-agent", BC], {
      outputs: { "cloud-agent": shown() },
    });
    expect(run.stdout).not.toContain("Waiting");
  });

  it("exits 4 under --json too, with the outcome in the document", async () => {
    const run = await runCli(["cloud-agent", BC, "--wait", "--json"], {
      outputs: {
        "cloud-agent": shown({
          outcome: { status: "pending", reason: "still running after 600 s" },
        }),
      },
    });
    expect([run.code, JSON.parse(run.stdout).outcome.status]).toEqual([
      4,
      "pending",
    ]);
  });

  it("exits 0 without --wait, whatever the agent's status", async () => {
    const run = await runCli(["cloud-agent", BC], {
      outputs: {
        "cloud-agent": shown({ cloudAgent: detail({ status: "running" }) }),
      },
    });
    expect(run.code).toBe(0);
  });

  it("exits 130 when interrupted while waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runCli(["cloud-agent", BC, "--wait"], {
      signal: controller.signal,
      hangForever: true,
    });
    expect([run.code, run.stderr]).toEqual([130, "grokbot: interrupted\n"]);
  });
});
