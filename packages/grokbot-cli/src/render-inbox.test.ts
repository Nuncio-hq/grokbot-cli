import type { CommandOutputs } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const ROW: CommandOutputs["inbox"]["items"][number] = {
  id: "bbbb2222",
  slug: "acme-web",
  state: "ok",
  kind: "bug",
  createdAt: "2026-10-20T07:00:00Z",
  ageSeconds: 5 * 3600,
  project: "Acme Web",
  severity: "critical",
  title: "Checkout fails",
  bot: { agentId: PRIMARY.agentId, name: "Primary Test" },
  blocking: true,
  yourTurnHere: true,
  forThisSession: false,
};
const LIST = (
  items: CommandOutputs["inbox"]["items"],
  extra: Partial<CommandOutputs["inbox"]> = {},
): CommandOutputs["inbox"] => ({
  scope: { kind: "all", source: "all" },
  computer: "example-mac",
  items,
  hiddenHandled: 0,
  hiddenExpired: 0,
  elsewhere: 0,
  projects: [],
  ...extra,
});

describe("inbox in human mode", () => {
  it("prints one line per item with the this-computer mark, and what it left out on stderr", async () => {
    const run = await runCli(["inbox"], {
      outputs: {
        inbox: LIST(
          [
            ROW,
            {
              id: "nnnn0001",
              slug: "acme-web",
              state: "needs-newer-grokbot",
              kind: "task",
              createdAt: "2026-10-20T08:00:00Z",
              ageSeconds: 4 * 3600,
              blocking: false,
              yourTurnHere: false,
              forThisSession: false,
            },
          ],
          { hiddenHandled: 2, elsewhere: 1, projects: ["other-site"] },
        ),
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("bbbb2222  bug");
    expect(run.stdout).toContain("critical");
    expect(run.stdout).toContain("5h");
    expect(run.stdout).toContain("Primary Test");
    expect(run.stdout).toContain("Checkout fails (this computer, your turn)");
    expect(run.stdout).toMatch(/nnnn0001.*needs a newer grokbot/);
    expect(run.stderr).toContain("2 handled");
    expect(run.stderr).toContain("other-site");
    expect(run.calls[0]).toMatchObject({
      name: "inbox",
      input: { all: false, "include-handled": false },
    });
  });

  it("marks items addressed to this session and to another, beside the other marks", async () => {
    const run = await runCli(["inbox"], {
      outputs: {
        inbox: LIST([
          {
            ...ROW,
            id: "ssss0001",
            title: "Mine",
            yourTurnHere: false,
            toSession: "omp:abcd1234",
            forThisSession: true,
          },
          {
            ...ROW,
            id: "oooo0002",
            title: "Theirs",
            toSession: "omp:zzzz9999",
          },
        ]),
      },
    });
    expect(run.stdout).toContain("Mine (for this session)");
    expect(run.stdout).toContain(
      "Theirs (for another session; this computer, your turn)",
    );
  });

  it("says so when nothing is open, and passes the flags to the command", async () => {
    const run = await runCli(
      ["inbox", "--project", "Acme Web", "--include-handled"],
      { outputs: { inbox: LIST([]) } },
    );
    expect(run.stdout).toBe("No open inbox items.\n");
    expect(run.calls[0]).toMatchObject({
      input: { project: "Acme Web", "include-handled": true },
    });
  });

  it("prints the JSON output as it is with --json", async () => {
    const out = LIST([ROW]);
    const run = await runCli(["inbox", "--json"], { outputs: { inbox: out } });
    expect(JSON.parse(run.stdout)).toEqual(out);
  });

  it("strips terminal control characters a bot wrote into a title", async () => {
    const run = await runCli(["inbox"], {
      outputs: {
        inbox: LIST([{ ...ROW, title: "ok\u001b[31m red\u0007\nnext line" }]),
      },
    });
    // Only line breaks (the table's own) may remain among the control characters.
    expect(run.stdout).not.toMatch(/[^\P{Cc}\n]/u);
  });

  it("prints the job id of a reply on stdout and where it went on stderr", async () => {
    const run = await runCli(["inbox-reply", "aaaa1111", "On it"], {
      outputs: {
        "inbox-reply": {
          id: "aaaa1111",
          jobId: "job-7",
          agent: PRIMARY,
          replyToId: "entry-150",
          queued: true,
          action: "reply",
        },
      },
    });
    expect(run.stdout).toBe("job-7\n");
    expect(run.stderr).toContain("Primary Test");
    expect(run.stderr).toContain("queued");
    expect(run.calls[0]).toMatchObject({
      name: "inbox-reply",
      input: { id: "aaaa1111", text: "On it" },
    });
  });

  it("takes a choice without text, and an outcome with its reason and link", async () => {
    const answer = await runCli(
      ["inbox-reply", "qqqq0001", "--choice", "yes"],
      {
        outputs: {
          "inbox-reply": {
            id: "qqqq0001",
            jobId: "job-8",
            agent: PRIMARY,
            queued: false,
            action: "answer",
          },
        },
      },
    );
    expect(answer.calls[0]).toMatchObject({
      input: { id: "qqqq0001", choice: "yes" },
    });
    const done = await runCli(
      [
        "inbox-done",
        "aaaa1111",
        "--outcome",
        "fixed",
        "--reason",
        "Patched",
        "--ref",
        "https://example.com/pr/1",
      ],
      {
        outputs: {
          "inbox-done": {
            id: "aaaa1111",
            jobId: "job-9",
            agent: PRIMARY,
            queued: false,
            closedAs: "fixed",
          },
        },
      },
    );
    expect(done.stdout).toBe("job-9\n");
    expect(done.calls[0]).toMatchObject({
      input: {
        outcome: "fixed",
        reason: "Patched",
        ref: "https://example.com/pr/1",
      },
    });
  });

  it("prints each saved path and refuses done without an outcome", async () => {
    const fetched = await runCli(
      ["inbox-fetch", "aaaa1111", "--out", "/tmp/o"],
      {
        outputs: {
          "inbox-fetch": {
            id: "aaaa1111",
            out: "/tmp/o",
            saved: [
              {
                name: "trace.txt",
                path: "/tmp/o/trace.txt",
                cloudPath: "/workspace/x",
                sizeBytes: 3,
              },
            ],
          },
        },
      },
    );
    expect(fetched.stdout).toBe("/tmp/o/trace.txt\n");
    const missing = await runCli(["inbox-done", "aaaa1111"]);
    expect(missing.code).toBe(2);
  });
});
