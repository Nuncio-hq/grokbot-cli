import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CallerSession,
  detectCallerSession,
  hasSession,
  SESSION_TAIL_BYTES,
  SESSION_TAIL_LINES,
} from "./caller-session.js";
import { type ClientLabel, detectClient } from "./usage-client.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ID_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID_B = "0190a1b2-c3d4-7e5f-8a9b-1f2e3d4c5b6a";

let home: string;
let project: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "grokbot-session-")));
  project = join(home, "Desktop", "acme", "web");
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A file in `folder` with `content`, last changed `secondsAgo` before NOW. */
async function touch(
  folder: string,
  name: string,
  secondsAgo = 5,
  content = "",
) {
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, content);
  const when = new Date(NOW - secondsAgo * 1000);
  await utimes(path, when, when);
  return path;
}

const ompFolder = (slug: string) => join(home, ".omp/agent/sessions", slug);
const ompFile = (id: string) => `2026-10-20T03-18-28-912Z_${id}.jsonl`;
const claudeSlug = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

function detect(
  options: {
    readonly caller?: ClientLabel | undefined;
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly argv?: readonly string[];
  } = {},
): Promise<CallerSession> {
  return detectCallerSession({
    env: options.env ?? {},
    cwd: options.cwd ?? project,
    home,
    now: () => NOW,
    argv: options.argv ?? [],
    caller: "caller" in options ? options.caller : "omp",
  });
}

describe("an omp caller", () => {
  const folder = () => ompFolder("-Desktop-acme-web");

  it("is the one session file of its folder changed in the last two minutes", async () => {
    await touch(folder(), ompFile(ID_A));
    await mkdir(join(folder(), `2026-10-20T03-18-28-912Z_${ID_A}`));
    expect(await detect()).toEqual({
      address: `omp:${ID_A}`,
      runtime: "omp",
      id: ID_A,
      signal: "recent session file",
    });
  });

  it("is ambiguous, with no id, when two sessions of the folder are recent", async () => {
    await touch(folder(), ompFile(ID_A), 10);
    await touch(folder(), ompFile(ID_B), 90);
    const session = await detect();
    expect(session).toEqual({ signal: "ambiguous", candidates: 2 });
    expect(hasSession(session)).toBe(false);
  });

  it("ignores files older than two minutes, and has no session when none is recent", async () => {
    await touch(folder(), ompFile(ID_A), 300);
    expect(await detect()).toEqual({ signal: "none" });
    await touch(folder(), ompFile(ID_B), 119);
    expect(await detect()).toMatchObject({ address: `omp:${ID_B}` });
  });

  it("walks up to the nearest parent folder that has sessions", async () => {
    await touch(ompFolder("-Desktop-acme"), ompFile(ID_A));
    const deeper = join(project, "packages", "ui");
    await mkdir(deeper, { recursive: true });
    expect(await detect({ cwd: deeper })).toMatchObject({
      address: `omp:${ID_A}`,
    });
  });

  it("takes the closest existing folder, even when only a parent's session is recent", async () => {
    await touch(ompFolder("-Desktop-acme"), ompFile(ID_A));
    await touch(folder(), ompFile(ID_B), 3000);
    expect(await detect()).toEqual({ signal: "none" });
  });

  it("has no session when the folder, and every parent up to home, has none", async () => {
    expect(await detect()).toEqual({ signal: "none" });
  });

  it("reads file names and modification times only, never the content", async () => {
    const path = await touch(folder(), ompFile(ID_A));
    await chmod(path, 0o000);
    try {
      expect(await detect()).toMatchObject({ address: `omp:${ID_A}` });
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("ignores files that are not session files or whose id is not valid", async () => {
    await touch(folder(), "notes.txt");
    await touch(folder(), "2026-10-20T03-18-28-912Z_abc.jsonl");
    await touch(folder(), "2026-10-20T03-18-28-912Z_has space.jsonl");
    await touch(folder(), "no-underscore-here.jsonl");
    await touch(folder(), ompFile(ID_A));
    expect(await detect()).toMatchObject({ address: `omp:${ID_A}` });
  });

  it("reads the session folder an override names, with no folder per project", async () => {
    const custom = join(home, "custom-sessions");
    await touch(custom, ompFile(ID_B));
    expect(
      await detect({ env: { PI_CODING_AGENT_SESSION_DIR: custom } }),
    ).toMatchObject({ address: `omp:${ID_B}` });
  });
});

describe("a Claude Code caller", () => {
  const folder = (dir: string) =>
    join(home, ".claude/projects", claudeSlug(dir));

  it("is the one recent session file in the folder named after its path", async () => {
    await touch(folder(project), `${ID_A}.jsonl`);
    expect(await detect({ caller: "claude-code" })).toEqual({
      address: `claude-code:${ID_A}`,
      runtime: "claude-code",
      id: ID_A,
      signal: "recent session file",
    });
  });

  it("turns every character that is not a letter or digit into a dash, dots included", async () => {
    const dotted = join(home, ".t3", "my_project");
    await mkdir(dotted, { recursive: true });
    await touch(folder(dotted), `${ID_A}.jsonl`);
    expect(await detect({ caller: "claude-code", cwd: dotted })).toMatchObject({
      address: `claude-code:${ID_A}`,
    });
  });

  it("is ambiguous when two sessions are recent, and walks up from a subfolder", async () => {
    await touch(folder(project), `${ID_A}.jsonl`, 20);
    await touch(folder(project), `${ID_B}.jsonl`, 40);
    const sub = join(project, "src");
    await mkdir(sub);
    expect(await detect({ caller: "claude-code", cwd: sub })).toEqual({
      signal: "ambiguous",
      candidates: 2,
    });
  });

  it("follows CLAUDE_CONFIG_DIR", async () => {
    const config = join(home, "elsewhere");
    await touch(join(config, "projects", claudeSlug(project)), `${ID_A}.jsonl`);
    expect(
      await detect({
        caller: "claude-code",
        env: { CLAUDE_CONFIG_DIR: config },
      }),
    ).toMatchObject({ address: `claude-code:${ID_A}` });
  });
});

describe("two recent sessions told apart by this command", () => {
  const folder = () => ompFolder("-Desktop-acme-web");
  const ARGV = ["inbox", "wait", "--job", "3f9a1c2e"];
  const OTHER_ARGV = ["inbox", "wait", "--job", "77aa88bb"];
  const MATCHED = "recent session file, matched by this command";
  const AMBIGUOUS = { signal: "ambiguous", candidates: 2 };

  /** A session line as a runtime stores a command it is about to run: the command inside a JSON string. */
  const ran = (command: string) =>
    JSON.stringify({ type: "toolCall", arguments: { command } });
  const grokbot = (argv: readonly string[]) => ran(`grokbot ${argv.join(" ")}`);
  const OTHER = JSON.stringify({ type: "message", text: "thinking aloud" });

  /** A recent omp session file with these lines, one per line, ending with a newline. */
  const session = (id: string, lines: readonly string[], secondsAgo = 5) =>
    touch(folder(), ompFile(id), secondsAgo, `${lines.join("\n")}\n`);

  const matched = (id: string) => ({
    address: `omp:${id}`,
    runtime: "omp",
    id,
    signal: MATCHED,
  });

  it("is the session whose last lines hold every argument", async () => {
    await session(ID_A, [OTHER, grokbot(ARGV)]);
    await session(ID_B, [OTHER, grokbot(OTHER_ARGV)]);
    expect(await detect({ argv: ARGV })).toEqual(matched(ID_A));
    expect(await detect({ argv: OTHER_ARGV })).toEqual(matched(ID_B));
  });

  it("is ambiguous when both sessions hold the arguments, or neither does", async () => {
    await session(ID_A, [OTHER, grokbot(ARGV)]);
    await session(ID_B, [grokbot(ARGV), OTHER]);
    expect(await detect({ argv: ARGV })).toEqual(AMBIGUOUS);
    expect(await detect({ argv: ["inbox", "check"] })).toEqual(AMBIGUOUS);
  });

  it("needs every argument, not just some", async () => {
    await session(ID_A, [OTHER, grokbot(ARGV)]);
    await session(ID_B, [OTHER, grokbot(["inbox", "wait"])]);
    expect(await detect({ argv: ARGV })).toEqual(matched(ID_A));
    expect(await detect({ argv: [...ARGV, "--timeout", "7m"] })).toEqual(
      AMBIGUOUS,
    );
  });

  it("matches an argument with spaces and double quotes by its JSON-escaped form", async () => {
    const argv = ["send", 'say "hi" to\\ them'];
    await session(ID_A, [OTHER, ran(`grokbot send 'say "hi" to\\ them'`)]);
    await session(ID_B, [OTHER, ran("grokbot send 'say hi to them'")]);
    expect(await detect({ argv })).toEqual(matched(ID_A));
  });

  it("matches the arguments as the phrase they were typed as, not the same words apart", async () => {
    await session(ID_A, [OTHER, grokbot(["inbox", "check"])]);
    await session(ID_B, [
      JSON.stringify({
        type: "message",
        text: "read the inbox, then check the docs",
      }),
    ]);
    expect(await detect({ argv: ["inbox", "check"] })).toEqual(matched(ID_A));
  });

  it("counts only the last SESSION_TAIL_LINES non-empty lines", async () => {
    const n = SESSION_TAIL_LINES;
    // The command is the n-th line from the end in A (blank lines do not count) and the (n+1)-th in B.
    await session(ID_A, [grokbot(ARGV), "", ...Array(n - 1).fill(OTHER), ""]);
    await session(ID_B, [grokbot(ARGV), ...Array(n).fill(OTHER)]);
    expect(await detect({ argv: ARGV })).toEqual(matched(ID_A));
  });

  it("does not count a match only beyond the last SESSION_TAIL_LINES lines", async () => {
    const n = SESSION_TAIL_LINES;
    await session(ID_A, [grokbot(ARGV), ...Array(n).fill(OTHER)]);
    await session(ID_B, [grokbot(ARGV), ...Array(n + 1).fill(OTHER)]);
    expect(await detect({ argv: ARGV })).toEqual(AMBIGUOUS);
  });

  it("does not tell them apart by empty arguments", async () => {
    await session(ID_A, [OTHER, grokbot(ARGV)]);
    await session(ID_B, [OTHER, OTHER]);
    expect(await detect({ argv: [] })).toEqual(AMBIGUOUS);
    expect(await detect({ argv: ["", ""] })).toEqual(AMBIGUOUS);
    expect(await detect({ argv: ["", ...ARGV] })).toEqual(matched(ID_A));
  });

  it("finds the command at the end of a file larger than the tail it reads", async () => {
    const filler = Array(40).fill(JSON.stringify({ text: "x".repeat(10_000) }));
    expect(filler.join("\n").length).toBeGreaterThan(SESSION_TAIL_BYTES);
    await session(ID_A, [...filler, grokbot(ARGV)]);
    await session(ID_B, [OTHER, OTHER]);
    expect(await detect({ argv: ARGV })).toEqual(matched(ID_A));
  });

  it("reads no more than the last 256 KB of a file", async () => {
    // One line whose command is followed by more than 256 KB: a read of the whole file
    // would find it in both sessions and give up.
    const long = JSON.stringify({
      type: "toolCall",
      arguments: { command: `grokbot ${ARGV.join(" ")}` },
      output: "x".repeat(SESSION_TAIL_BYTES + 1000),
    });
    expect(long.length).toBeGreaterThan(SESSION_TAIL_BYTES);
    await session(ID_A, [long]);
    await session(ID_B, [OTHER, grokbot(ARGV)]);
    expect(await detect({ argv: ARGV })).toEqual(matched(ID_B));
  });

  it("leaves a single recent session alone, whatever its lines hold", async () => {
    await session(ID_A, [OTHER]);
    await session(ID_B, [grokbot(ARGV)], 300);
    expect(await detect({ argv: ARGV })).toEqual({
      address: `omp:${ID_A}`,
      runtime: "omp",
      id: ID_A,
      signal: "recent session file",
    });
  });

  it("tells two Claude Code sessions apart the same way", async () => {
    const dir = join(home, ".claude/projects", claudeSlug(project));
    await touch(dir, `${ID_A}.jsonl`, 5, `${grokbot(OTHER_ARGV)}\n`);
    await touch(dir, `${ID_B}.jsonl`, 5, `${grokbot(ARGV)}\n`);
    expect(await detect({ caller: "claude-code", argv: ARGV })).toEqual({
      address: `claude-code:${ID_B}`,
      runtime: "claude-code",
      id: ID_B,
      signal: MATCHED,
    });
  });

  it("uses this process's arguments when none are given", async () => {
    await session(ID_A, [OTHER, grokbot(ARGV)]);
    await session(ID_B, [OTHER, grokbot(OTHER_ARGV)]);
    const saved = process.argv;
    process.argv = ["bun", "grokbot", ...ARGV];
    try {
      expect(
        await detectCallerSession({
          env: {},
          cwd: project,
          home,
          now: () => NOW,
          caller: "omp",
        }),
      ).toEqual(matched(ID_A));
    } finally {
      process.argv = saved;
    }
  });
});

describe("a Codex caller", () => {
  it("is its thread id", async () => {
    expect(
      await detect({ caller: "codex", env: { CODEX_THREAD_ID: ID_A } }),
    ).toEqual({
      address: `codex:${ID_A}`,
      runtime: "codex",
      id: ID_A,
      signal: "CODEX_THREAD_ID",
    });
  });

  it("has none without a valid thread id, and no other caller reads the variable", async () => {
    expect(await detect({ caller: "codex" })).toEqual({ signal: "none" });
    expect(
      await detect({ caller: "codex", env: { CODEX_THREAD_ID: "a b" } }),
    ).toEqual({ signal: "none" });
    expect(
      await detect({ caller: "gemini", env: { CODEX_THREAD_ID: ID_A } }),
    ).toEqual({ signal: "none" });
  });
});

describe("GROKBOT_SESSION", () => {
  it("names the whole address, whoever the caller is", async () => {
    expect(
      await detect({
        caller: "other-agent",
        env: { GROKBOT_SESSION: "hermes:run-0042" },
      }),
    ).toEqual({
      address: "hermes:run-0042",
      runtime: "hermes",
      id: "run-0042",
      signal: "GROKBOT_SESSION",
    });
  });

  it("takes the runtime from the caller when it gives an id alone", async () => {
    expect(
      await detect({ caller: "claude-code", env: { GROKBOT_SESSION: ID_A } }),
    ).toMatchObject({
      address: `claude-code:${ID_A}`,
      signal: "GROKBOT_SESSION",
    });
  });

  it("beats the recent session file and the thread variable", async () => {
    await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_A));
    expect(
      await detect({ env: { GROKBOT_SESSION: `omp:${ID_B}` } }),
    ).toMatchObject({ address: `omp:${ID_B}` });
    expect(
      await detect({
        caller: "codex",
        env: { GROKBOT_SESSION: "xyz-1234", CODEX_THREAD_ID: ID_A },
      }),
    ).toMatchObject({ address: "codex:xyz-1234" });
  });

  it.each([
    ["an id with a space", "bad id here"],
    ["an id that is too short", "abc"],
    ["an id that is too long", "a".repeat(101)],
    ["a runtime in capitals", "OMP:abcd1234"],
    ["an empty id", "omp:"],
    ["an empty value", "  "],
  ])(
    "ignores %s and detects the session as without it",
    async (_name, value) => {
      await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_A));
      expect(await detect({ env: { GROKBOT_SESSION: value } })).toMatchObject({
        address: `omp:${ID_A}`,
        signal: "recent session file",
      });
    },
  );

  it("gives a person at a terminal, and a host with no caller, no session", async () => {
    const env = { GROKBOT_SESSION: `omp:${ID_A}` };
    expect(await detect({ caller: "human", env })).toEqual({ signal: "none" });
    expect(await detect({ caller: undefined, env })).toEqual({
      signal: "none",
    });
  });
});

describe("a runtime's own session source only", () => {
  const OUTER_OMP = { OMPCODE: "1", CLAUDECODE: "1" };
  const SHELLS = ["sh", "zsh"];
  const TAIL = ["bun", "zsh", "tern"];

  /** The caller as `detectClient` names it for `chain`, then its session. */
  async function whoami(
    env: Record<string, string>,
    chain: readonly string[],
  ): Promise<{ label: ClientLabel; session: CallerSession }> {
    const { label } = detectClient({
      env,
      isTTY: false,
      processChain: () => chain,
    });
    return { label, session: await detect({ caller: label, env }) };
  }

  it("is the Codex thread for Codex nested in omp, not the omp session file", async () => {
    await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_B));
    const env = { ...OUTER_OMP, CODEX_THREAD_ID: ID_A, CODEX_SESSION_ID: ID_A };
    expect(await whoami(env, [...SHELLS, "codex", ...TAIL])).toEqual({
      label: "codex",
      session: {
        address: `codex:${ID_A}`,
        runtime: "codex",
        id: ID_A,
        signal: "CODEX_THREAD_ID",
      },
    });
  });

  it("falls back to CODEX_SESSION_ID when CODEX_THREAD_ID is absent or invalid", async () => {
    expect(
      await detect({ caller: "codex", env: { CODEX_SESSION_ID: ID_A } }),
    ).toMatchObject({ address: `codex:${ID_A}`, signal: "CODEX_SESSION_ID" });
    expect(
      await detect({
        caller: "codex",
        env: { CODEX_THREAD_ID: "a b", CODEX_SESSION_ID: ID_B },
      }),
    ).toMatchObject({ address: `codex:${ID_B}` });
  });

  it("is the Cursor conversation for Cursor nested in omp", async () => {
    await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_B));
    const env = {
      ...OUTER_OMP,
      CURSOR_AGENT: "1",
      CURSOR_CONVERSATION_ID: ID_A,
      CURSOR_REQUEST_ID: ID_B,
    };
    expect(await whoami(env, [...SHELLS, "cursor-agent", ...TAIL])).toEqual({
      label: "cursor",
      session: {
        address: `cursor:${ID_A}`,
        runtime: "cursor",
        id: ID_A,
        signal: "CURSOR_CONVERSATION_ID",
      },
    });
  });

  it("has no Cursor session for a GrokBot bot's own commands (SAND_AGENT)", async () => {
    const env = { SAND_AGENT: "1", CURSOR_CONVERSATION_ID: ID_A };
    expect(await detect({ caller: "cursor", env })).toEqual({ signal: "none" });
    expect(
      await detect({
        caller: "cursor",
        env: { ...env, GROKBOT_SESSION: "cursor-run:abcd1234" },
      }),
    ).toMatchObject({ address: "cursor-run:abcd1234" });
  });

  it("is CLAUDE_CODE_SESSION_ID for Claude Code nested in omp, without reading any file", async () => {
    // A recent omp file and a recent Claude file in the folder must both be ignored.
    await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_B));
    await touch(
      join(home, ".claude/projects", claudeSlug(project)),
      `${ID_B}.jsonl`,
    );
    const env = {
      ...OUTER_OMP,
      AI_AGENT: "claude-code_2-1-299_agent",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: ID_A,
    };
    expect(await whoami(env, [...SHELLS, "claude", ...TAIL])).toEqual({
      label: "claude-code",
      session: {
        address: `claude-code:${ID_A}`,
        runtime: "claude-code",
        id: ID_A,
        signal: "CLAUDE_CODE_SESSION_ID",
      },
    });
  });

  it("is omp with its session file when omp runs alone, its chain showing no runtime", async () => {
    await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_A));
    expect(await whoami(OUTER_OMP, ["bun", "zsh", "tern"])).toEqual({
      label: "omp",
      session: {
        address: `omp:${ID_A}`,
        runtime: "omp",
        id: ID_A,
        signal: "recent session file",
      },
    });
  });

  it("falls back to the environment markers when the process list cannot be read", async () => {
    await touch(ompFolder("-Desktop-acme-web"), ompFile(ID_A));
    expect(await whoami(OUTER_OMP, [])).toMatchObject({
      label: "omp",
      session: { address: `omp:${ID_A}` },
    });
    expect(await whoami({ CODEX_THREAD_ID: ID_B }, [])).toMatchObject({
      label: "codex",
      session: { address: `codex:${ID_B}` },
    });
  });

  it("ignores the variables of other runtimes", async () => {
    const env = {
      CODEX_THREAD_ID: ID_A,
      CURSOR_CONVERSATION_ID: ID_A,
      CLAUDE_CODE_SESSION_ID: ID_A,
    };
    expect(await detect({ caller: "gemini", env })).toEqual({ signal: "none" });
    expect(await detect({ caller: "omp", env })).toEqual({ signal: "none" });
    expect(
      await detect({ caller: "codex", env: { CURSOR_CONVERSATION_ID: ID_A } }),
    ).toEqual({ signal: "none" });
    expect(
      await detect({ caller: "cursor", env: { CODEX_THREAD_ID: ID_A } }),
    ).toEqual({ signal: "none" });
    expect(
      await detect({ caller: "claude-code", env: { CODEX_THREAD_ID: ID_A } }),
    ).toEqual({ signal: "none" });
  });
});
