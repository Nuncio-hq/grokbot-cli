import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  governanceRunner,
  realGovernanceRunner,
} from "./fixtures/governance-test-kit.js";

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof GrokBotError ? [error.code, error.message] : error;
};

describe("computers", () => {
  it("lists each registered computer with its true capabilities", async () => {
    const { run } = governanceRunner({
      ListGrokBotUserComputers: [
        {
          computers: [
            {
              machineId: "m-1",
              lastSeenAtMs: "1791948600000",
              hello: {
                label: "Oscar's Mac",
                kind: "desktop",
                capabilities: {
                  messagesOp: true,
                  aiToolSetup: true,
                  shell: false,
                },
              },
            },
          ],
        },
      ],
    });
    expect(await run("computers", { json: false })).toEqual({
      computers: [
        {
          machineId: "m-1",
          label: "Oscar's Mac",
          kind: "desktop",
          lastSeenAtMs: "1791948600000",
          capabilities: ["aiToolSetup", "messagesOp"],
        },
      ],
    });
  });
});

describe("mcp-list", () => {
  it("lists Box MCP servers from getMcpState", async () => {
    const { run, log } = governanceRunner(
      {},
      {
        getMcpState: [
          {
            servers: [
              {
                name: "Cloudflare",
                serverIdentifier: "user-Cloudflare",
                transport: "stdio",
                toolCount: 4,
                disabledToolCount: 1,
                status: "connected",
              },
            ],
          },
        ],
      },
    );
    expect([await run("mcp-list", { json: false }), log]).toEqual([
      {
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
      [{ via: "gateway", method: "getMcpState", body: {}, confirmed: false }],
    ]);
  });

  it("reports a getMcpState reply without a servers list as a protocol break", async () => {
    const { run } = governanceRunner({}, { getMcpState: [{ state: "ok" }] });
    expect(await failure(run("mcp-list", { json: false }))).toEqual([
      "protocol",
      "getMcpState: the reply has no servers list.",
    ]);
  });
});

describe("mcp-call", () => {
  const input = {
    server: "user-Cloudflare",
    tool: "whoami",
    args: ' { "a" : 1 } ',
    json: false,
  } as const;

  it("refuses without --yes before any network call, through the real runner", async () => {
    const { runner, log } = realGovernanceRunner();
    expect([
      await failure(runner.run("mcp-call", { ...input, yes: false })),
      log,
    ]).toEqual([
      ["safety", "mcp-call changes or deletes live data. Re-run with --yes."],
      [],
    ]);
  });

  it("calls the tool confirmed, without claiming a user click, and redacts token-like output", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-xyz";
    const { runner, log } = realGovernanceRunner(
      {},
      {
        callMcpAppTool: [
          { content: [{ type: "text", text: `ok token=${jwt}` }] },
        ],
      },
    );
    const out = await runner.run("mcp-call", { ...input, yes: true });
    expect([out.result, log]).toEqual([
      {
        text: "ok token=[redacted]",
        topLevelKeys: ["content"],
        isError: false,
      },
      [
        {
          via: "gateway",
          method: "callMcpAppTool",
          body: {
            serverIdentifier: "user-Cloudflare",
            toolName: "whoami",
            argumentsJson: '{"a":1}',
            userActivated: false,
          },
          confirmed: true,
        },
      ],
    ]);
  });

  it("tells the owner to click in the app when the gateway needs a user activation", async () => {
    const { runner } = realGovernanceRunner(
      {},
      { callMcpAppTool: [{ code: "needs_activation" }] },
    );
    expect(
      await failure(runner.run("mcp-call", { ...input, yes: true })),
    ).toEqual([
      "safety",
      "user-Cloudflare/whoami needs a click in the Grok Bot app, so grokbot cannot run it. Run it from the app instead.",
    ]);
  });

  it("rejects --args that is not a JSON object before calling the gateway", async () => {
    const { runner, log } = realGovernanceRunner();
    expect([
      await failure(
        runner.run("mcp-call", { ...input, args: "[1]", yes: true }),
      ),
      log,
    ]).toEqual([["not-found", "--args must be a JSON object, e.g. '{}'."], []]);
  });
});
