import type { CommandOutputs } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { PRIMARY, STAFF } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

type Card = CommandOutputs["approvals"]["agents"][number]["cards"][number];
const seq = (n: number) => String(n) as Card["seq"];
const WIDGET: Card = {
  entryId: "t2s0",
  seq: seq(6),
  type: "widget",
  prompt: "Pick a color",
  options: ["Red", "Blue", "Green"],
};
const LOCAL: Card = {
  entryId: "t28s1",
  seq: seq(96),
  type: "local-tool-permission",
  requestId: "r-1",
  action: "run-command",
  target: "ls -la",
};
const resolve = (overrides: Partial<CommandOutputs["approve"]> = {}) => ({
  agent: STAFF,
  card: LOCAL,
  verb: "approve" as const,
  resolution: "approved once",
  wroteLocalApproval: true,
  ...overrides,
});

describe("governance commands in human mode", () => {
  it("prints open cards as a table, with an awaiting row for a cardless wait", async () => {
    const run = await runCli(["approvals"], {
      outputs: {
        approvals: {
          agents: [
            { agent: PRIMARY, awaiting: null, handoff: null, cards: [WIDGET] },
            {
              agent: STAFF,
              awaiting: "Permission needed",
              handoff: null,
              cards: [],
            },
          ],
        },
      },
    });
    expect(run).toMatchObject({
      stdout:
        "AGENT         CARD    ID    DETAIL\n" +
        "Primary Test  widget  t2s0  Pick a color [Red | Blue | Green]\n" +
        "Staff Test    -       -     awaiting: Permission needed (no open card in the last 50 rows; check the bot in the GrokBot app)\n",
      code: 0,
    });
    const none = await runCli(["approvals"], {
      outputs: { approvals: { agents: [] } },
    });
    expect(none.stdout).toBe("No open approval cards.\n");
  });

  it("names a box hand-off and the cards only the owner can answer", async () => {
    const form: Card = {
      entryId: "t9s0",
      seq: seq(12),
      type: "user-form",
      summary: 'Secure Form "Shipping address" (2 fields)',
    };
    const run = await runCli(["approvals"], {
      outputs: {
        approvals: {
          agents: [
            {
              agent: PRIMARY,
              awaiting: null,
              handoff: { requestId: "h-1", instruction: "Sign in to Xero" },
              cards: [form],
            },
          ],
        },
      },
    });
    expect(run.stdout).toBe(
      "AGENT         CARD         ID    DETAIL\n" +
        "Primary Test  box-handoff  h-1   Take over the bot's computer: Sign in to Xero (only the owner can answer this in the GrokBot app)\n" +
        'Primary Test  user-form    t9s0  Secure Form "Shipping address" (2 fields) (only the owner can answer this in the GrokBot app)\n',
    );
  });

  it("prints accepted for an answer and passes the value through", async () => {
    const run = await runCli(["answer", "Blue", "--agent", "Primary Test"], {
      outputs: {
        answer: {
          agent: PRIMARY,
          card: WIDGET,
          dismissed: false,
          value: "Blue",
        },
      },
    });
    expect([run.stdout, run.stderr, run.calls[0]?.input]).toEqual([
      "accepted\n",
      'Answered widget t2s0 on Primary Test with "Blue".\n',
      { value: "Blue", agent: "Primary Test", dismiss: false, json: false },
    ]);
  });

  it("prints the resolution and notes the Mac approvals file", async () => {
    const run = await runCli(["approve", "--agent", "Staff Test", "--yes"], {
      outputs: { approve: resolve() },
    });
    expect([run.stdout, run.stderr]).toEqual([
      "approved once\n",
      "Resolved local-tool-permission t28s1 on Staff Test (201a8cb2). Recorded it in ~/.grokbot/local-tool-approvals.json for the Mac daemon.\n",
    ]);
  });

  it("refuses approve without --yes in the runner's own words", async () => {
    const { GrokBotError } = await import("grokbot-core");
    const run = await runCli(["approve", "--agent", "Staff Test"], {
      error: new GrokBotError(
        "safety",
        "approve changes or deletes live data. Re-run with --yes.",
      ),
    });
    expect([run.code, run.stderr]).toEqual([
      1,
      "grokbot: approve changes or deletes live data. Re-run with --yes.\n",
    ]);
  });

  it("prints computers and MCP servers as tables", async () => {
    const computers = await runCli(["computers"], {
      outputs: {
        computers: {
          computers: [
            {
              machineId: "m-1",
              label: "Mac",
              kind: "desktop",
              lastSeenAtMs: "1791948600000",
              capabilities: ["aiToolSetup", "messagesOp"],
            },
          ],
        },
      },
    });
    const mcp = await runCli(["mcp-list"], {
      outputs: {
        "mcp-list": {
          servers: [
            {
              name: "Cloudflare",
              serverIdentifier: "user-Cloudflare",
              transport: "stdio",
              toolCount: 4,
              disabledToolCount: 1,
              status: "connected",
              isTeamServer: false,
            },
          ],
        },
      },
    });
    expect([computers.stdout, mcp.stdout]).toEqual([
      "MACHINE  LABEL  KIND     LAST SEEN (UTC)   CAPABILITIES\n" +
        "m-1      Mac    desktop  2026-10-14T03:30  aiToolSetup,messagesOp\n",
      "SERVER           NAME        TOOLS       STATUS\n" +
        "user-Cloudflare  Cloudflare  4 (+1 off)  connected\n",
    ]);
  });

  it("prints the vnc URL only under --print-url, with a credential warning", async () => {
    const opened = await runCli(["vnc", "--window", "3"], {
      outputs: { vnc: { window: 3, opened: true, url: undefined } },
    });
    const printed = await runCli(["vnc", "--window", "3", "--print-url"], {
      outputs: {
        vnc: {
          window: 3,
          opened: false,
          url: "https://box.example/vnc.html?x=1",
        },
      },
    });
    expect([
      opened.stdout,
      opened.stderr,
      printed.stdout,
      printed.stderr,
    ]).toEqual([
      "Opened desktop window 3.\n",
      "",
      "https://box.example/vnc.html?x=1\n",
      "This link is a credential: anyone holding it can watch and control the desktop. Do not share or log it.\n",
    ]);
  });

  it("selects the desktop by --window alone, refusing --agent on vnc", async () => {
    const run = await runCli([
      "vnc",
      "--agent",
      "Primary Test",
      "--window",
      "3",
    ]);
    expect([run.code, run.stderr.split("\n")[0], run.calls]).toEqual([
      2,
      "grokbot: vnc: unknown flag --agent",
      [],
    ]);
  });

  it("reports the worker's exit and how many times it was handed the token", async () => {
    const run = await runCli(["worker-start", "--yes"], {
      outputs: {
        "worker-start": {
          plan: { command: ["cursor-agent", "worker", "start"], envNames: [] },
          exitCode: 0,
          tokenServes: 2,
        },
      },
    });
    expect([run.code, run.stdout]).toEqual([
      0,
      "Worker exited with code 0. Served the token 2 times.\n",
    ]);
  });

  it("prints the worker plan, quoting only when needed, and lists registered computers", async () => {
    const run = await runCli(["worker-plan", "--name", "Oscar's Mac"], {
      outputs: {
        "worker-plan": {
          registered: ["example-mac"],
          plan: {
            command: [
              "/opt/cursor-agent",
              "worker",
              "--name",
              "Oscar's Mac",
              "start",
            ],
            envNames: ["AGENT_CLI_CREDENTIAL_STORE", "HOME"],
          },
        },
      },
    });
    expect([run.stdout, run.stderr, run.calls[0]?.input]).toEqual([
      "/opt/cursor-agent worker --name 'Oscar'\\''s Mac' start\nenv: AGENT_CLI_CREDENTIAL_STORE HOME\n",
      "Nothing started. $RUN_DIR is a fresh 0700 temp dir; token.fifo serves the token without writing it to disk.\nRegistered computers now: example-mac.\n",
      { name: "Oscar's Mac", json: false },
    ]);
  });
});
