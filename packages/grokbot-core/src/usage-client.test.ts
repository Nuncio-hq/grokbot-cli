import { describe, expect, it } from "vitest";
import { detectClient } from "./usage-client.js";

describe("detectClient", () => {
  it.each([
    ["a person in a terminal", {}, true, undefined, "human"],
    ["a script with no terminal", {}, false, undefined, "script"],
    [
      "Claude in the desktop app (live 16 Oct)",
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        AI_AGENT: "claude-code_2-1-299_agent",
      },
      false,
      undefined,
      "claude-desktop",
    ],
    [
      "Claude Code in a terminal",
      { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      true,
      undefined,
      "claude-code",
    ],
    [
      "Claude Code with only CLAUDECODE",
      { CLAUDECODE: "1" },
      false,
      undefined,
      "claude-code",
    ],
    [
      "another agent by AI_AGENT",
      { AI_AGENT: "codex_1.2" },
      false,
      undefined,
      "codex",
    ],
    [
      "an unknown agent by AI_AGENT",
      { AI_AGENT: "foo-bot" },
      true,
      undefined,
      "other-agent",
    ],
    ["an MCP client by name", {}, false, "Cursor", "cursor"],
    [
      "Claude Code over MCP inside the desktop app",
      { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
      false,
      "claude-code",
      "claude-desktop",
    ],
    ["an MCP client unknown by name", {}, false, "some-host", "other-agent"],
    [
      "GROKBOT_CLIENT over every other signal",
      { GROKBOT_CLIENT: "hermes", CLAUDECODE: "1" },
      true,
      "claude-code",
      "hermes",
    ],
    [
      "GROKBOT_CLIENT that is not a label, mapped by name",
      { GROKBOT_CLIENT: "my-codex-fork" },
      true,
      undefined,
      "codex",
    ],
  ] as const)("labels %s", (_, env, isTTY, mcpClientName, label) => {
    expect(detectClient({ env, isTTY, mcpClientName })).toBe(label);
  });

  it("never reads variables it does not need, such as an email", () => {
    const read: string[] = [];
    const env = new Proxy(
      { CLAUDE_CODE_USER_EMAIL: "someone@example.com" },
      {
        get(target, key: string) {
          read.push(key);
          return (target as Record<string, string>)[key];
        },
      },
    );
    detectClient({ env, isTTY: false });
    expect(read.sort()).toEqual([
      "AI_AGENT",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "GROKBOT_CLIENT",
    ]);
  });
});
