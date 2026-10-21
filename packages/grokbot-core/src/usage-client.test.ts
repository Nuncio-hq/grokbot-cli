import { describe, expect, it } from "vitest";
import { CLIENT_NAMES, detectClient, labelForName } from "./usage-client.js";

const NO_CHAIN = () => [];

describe("detectClient", () => {
  it.each([
    ["a person in a terminal", {}, true, undefined, "human", "terminal"],
    ["a script with no terminal", {}, false, undefined, "script", "terminal"],
    [
      "omp, which also sets CLAUDECODE for compatibility",
      { OMPCODE: "1", CLAUDECODE: "1", AGENT: "1" },
      false,
      undefined,
      "omp",
      "OMPCODE",
    ],
    [
      "omp in a terminal",
      { OMPCODE: "1", CLAUDECODE: "1" },
      true,
      undefined,
      "omp",
      "OMPCODE",
    ],
    [
      "Codex by its thread",
      { CODEX_THREAD_ID: "t-1", CLAUDECODE: "1" },
      false,
      undefined,
      "codex",
      "CODEX_THREAD_ID",
    ],
    [
      "Codex by its sandbox",
      { CODEX_SANDBOX: "seatbelt" },
      false,
      undefined,
      "codex",
      "CODEX_SANDBOX",
    ],
    [
      "Gemini CLI",
      { GEMINI_CLI: "1" },
      false,
      undefined,
      "gemini",
      "GEMINI_CLI",
    ],
    ["OpenCode", { OPENCODE: "1" }, false, undefined, "opencode", "OPENCODE"],
    [
      "Cursor's agent",
      { CURSOR_AGENT: "1" },
      false,
      undefined,
      "cursor",
      "CURSOR_AGENT",
    ],
    [
      "Copilot",
      { COPILOT_CLI: "1" },
      false,
      undefined,
      "copilot",
      "COPILOT_CLI",
    ],
    ["Junie", { JUNIE_DATA: "/x" }, false, undefined, "junie", "JUNIE_DATA"],
    [
      "Auggie",
      { AUGMENT_AGENT: "1" },
      false,
      undefined,
      "auggie",
      "AUGMENT_AGENT",
    ],
    [
      "Goose",
      { GOOSE_PROVIDER: "x" },
      false,
      undefined,
      "goose",
      "GOOSE_PROVIDER",
    ],
    ["Replit", { REPL_ID: "abc" }, false, undefined, "replit", "REPL_ID"],
    [
      "pi, found on PATH",
      { PATH: "/usr/bin:/home/u/.pi/agent/bin" },
      false,
      undefined,
      "pi",
      "PATH",
    ],
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
      "AI_AGENT",
    ],
    [
      "Claude Code in a terminal",
      { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      true,
      undefined,
      "claude-code",
      "CLAUDE_CODE_ENTRYPOINT",
    ],
    [
      "Claude Code with only CLAUDECODE",
      { CLAUDECODE: "1" },
      false,
      undefined,
      "claude-code",
      "CLAUDECODE",
    ],
    [
      "Claude Code with only CLAUDE_CODE",
      { CLAUDE_CODE: "1" },
      false,
      undefined,
      "claude-code",
      "CLAUDE_CODE",
    ],
    [
      "the desktop app by its entrypoint alone",
      { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
      false,
      undefined,
      "claude-desktop",
      "CLAUDE_CODE_ENTRYPOINT",
    ],
    [
      "another agent by AI_AGENT",
      { AI_AGENT: "codex_1.2" },
      false,
      undefined,
      "codex",
      "AI_AGENT",
    ],
    [
      "AI_AGENT over a runtime marker",
      { AI_AGENT: "gemini", OMPCODE: "1" },
      false,
      undefined,
      "gemini",
      "AI_AGENT",
    ],
    [
      "an unknown agent by AI_AGENT",
      { AI_AGENT: "foo-bot" },
      true,
      undefined,
      "other-agent",
      "AI_AGENT",
    ],
    ["an MCP client by name", {}, false, "Cursor", "cursor", "MCP client"],
    [
      "the MCP client name over a runtime marker",
      { OMPCODE: "1" },
      false,
      "codex",
      "codex",
      "MCP client",
    ],
    [
      "an MCP client named omp",
      {},
      false,
      "omp-coding-agent",
      "omp",
      "MCP client",
    ],
    [
      "Claude Code over MCP inside the desktop app",
      { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" },
      false,
      "claude-code",
      "claude-desktop",
      "MCP client",
    ],
    [
      "an MCP client unknown by name",
      {},
      false,
      "some-host",
      "other-agent",
      "MCP client",
    ],
    [
      "GROKBOT_CLIENT over every other signal",
      { GROKBOT_CLIENT: "hermes", AI_AGENT: "codex", OMPCODE: "1" },
      true,
      "claude-code",
      "hermes",
      "GROKBOT_CLIENT",
    ],
    [
      "GROKBOT_CLIENT that is not a label, mapped by name",
      { GROKBOT_CLIENT: "my-codex-fork" },
      true,
      undefined,
      "codex",
      "GROKBOT_CLIENT",
    ],
  ] as const)("labels %s", (_, env, isTTY, mcpClientName, label, signal) => {
    const detected = detectClient({
      env,
      isTTY,
      mcpClientName,
      processChain: NO_CHAIN,
    });
    expect(detected.label).toBe(label);
    expect(detected.signal).toContain(signal);
  });

  it("ignores a marker that is blank, 0 or false", () => {
    for (const value of ["", "  ", "0", "false"]) {
      expect(
        detectClient({
          env: { OMPCODE: value },
          isTTY: false,
          processChain: NO_CHAIN,
        }).label,
      ).toBe("script");
    }
  });

  it("never reports an environment value as the signal", () => {
    const secret = "session-abc-123";
    const { signal } = detectClient({
      env: { CODEX_THREAD_ID: secret },
      isTTY: false,
      processChain: NO_CHAIN,
    });
    expect(signal).not.toContain(secret);
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
    detectClient({ env, isTTY: false, processChain: NO_CHAIN });
    expect(read.sort()).toEqual([
      "AI_AGENT",
      "AUGMENT_AGENT",
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CODEX_SANDBOX",
      "CODEX_THREAD_ID",
      "COPILOT_AGENT",
      "COPILOT_CLI",
      "CURSOR_AGENT",
      "GEMINI_CLI",
      "GOOSE_PROVIDER",
      "GROKBOT_CLIENT",
      "JUNIE_DATA",
      "OMPCODE",
      "OPENCODE",
      "PATH",
      "REPL_ID",
    ]);
  });
});

describe("detectClient by process chain", () => {
  const SHELLS = ["sh", "zsh"];
  const OUTER = ["bun", "zsh", "tern"];
  const detect = (
    env: Record<string, string>,
    processChain: readonly string[],
    mcpClientName?: string,
  ) =>
    detectClient({
      env,
      isTTY: false,
      mcpClientName,
      processChain: () => processChain,
    });

  it.each([
    [
      "Codex nested in omp",
      { OMPCODE: "1", CODEX_THREAD_ID: "t-1" },
      "codex",
      "codex",
    ],
    [
      "Cursor nested in omp",
      { OMPCODE: "1", CURSOR_AGENT: "1" },
      "cursor-agent",
      "cursor",
    ],
    [
      "Claude Code nested in omp",
      { OMPCODE: "1", AI_AGENT: "claude-code_2-1-299_agent", CLAUDECODE: "1" },
      "claude",
      "claude-code",
    ],
    ["Gemini CLI by its process", { OMPCODE: "1" }, "gemini", "gemini"],
    ["omp itself on the chain", { CLAUDECODE: "1" }, "omp", "omp"],
  ] as const)("names %s, not the outer runtime", (_, env, name, label) => {
    expect(detect(env, [...SHELLS, name, ...OUTER])).toEqual({
      label,
      signal: `process ${name}`,
    });
  });

  it("takes the nearest runtime of the chain", () => {
    expect(detect({}, ["sh", "codex", "bun", "omp", "zsh"]).label).toBe(
      "codex",
    );
  });

  it("beats AI_AGENT and every marker, but not GROKBOT_CLIENT or the MCP client name", () => {
    const chain = ["sh", "codex"];
    const env = { AI_AGENT: "gemini", OMPCODE: "1" };
    expect(detect(env, chain).label).toBe("codex");
    expect(detect({ ...env, GROKBOT_CLIENT: "hermes" }, chain)).toEqual({
      label: "hermes",
      signal: "GROKBOT_CLIENT",
    });
    expect(detect(env, chain, "goose")).toEqual({
      label: "goose",
      signal: "MCP client",
    });
  });

  it("goes on with the environment when the chain has no runtime or is empty", () => {
    expect(detect({ OMPCODE: "1" }, [...SHELLS, ...OUTER])).toEqual({
      label: "omp",
      signal: "OMPCODE",
    });
    expect(detect({ CODEX_THREAD_ID: "t-1" }, [])).toEqual({
      label: "codex",
      signal: "CODEX_THREAD_ID",
    });
  });

  it("folds Claude Code into the desktop app by its entrypoint", () => {
    expect(
      detect({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, ["sh", "claude"]),
    ).toEqual({ label: "claude-desktop", signal: "process claude" });
  });

  it("does not read the chain when an explicit signal decides", () => {
    const chain = () => {
      throw new Error("the chain was read");
    };
    expect(
      detectClient({
        env: { GROKBOT_CLIENT: "omp" },
        isTTY: false,
        processChain: chain,
      }).label,
    ).toBe("omp");
  });
});

describe("labelForName", () => {
  it.each([
    ["omp", "omp"],
    ["omp-coding-agent", "omp"],
    ["Gemini CLI", "gemini"],
    ["opencode", "opencode"],
    ["GitHub Copilot", "copilot"],
    ["junie", "junie"],
    ["auggie", "auggie"],
    ["goose", "goose"],
    ["replit-agent", "replit"],
    ["pi", "pi"],
    ["pi-coding-agent", "pi"],
    ["compose", "other-agent"],
    ["nothing-known", "other-agent"],
  ] as const)("maps %s to %s", (name, label) => {
    expect(labelForName(name)).toBe(label);
  });
});

describe("CLIENT_NAMES", () => {
  it("shows each runtime by a display name", () => {
    expect(CLIENT_NAMES).toMatchObject({
      omp: "omp",
      "claude-code": "Claude Code",
      "claude-desktop": "Claude Desktop",
      codex: "Codex",
      cursor: "Cursor",
      gemini: "Gemini CLI",
      opencode: "OpenCode",
      hermes: "Hermes",
      copilot: "GitHub Copilot",
      pi: "pi",
      "other-agent": "an AI agent",
      human: "terminal",
      script: "script",
    });
  });
});
