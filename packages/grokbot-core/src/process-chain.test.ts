import { describe, expect, it } from "vitest";
import { MAX_CHAIN_DEPTH, walkProcessChain } from "./process-chain.js";

/** `ps -A -o pid=,ppid=,comm=` rows: the program is the whole rest of the row. */
const TABLE = [
  "    1     0 /sbin/launchd",
  "  100     1 /bin/zsh",
  "  200   100 /Users/someone/.bun/bin/bun",
  "  300   200 /bin/zsh",
  "  400   300 /Users/someone/.local/share/cursor-agent/versions/2026.10.1/cursor-agent",
  "  500   400 /bin/sh",
  "  600   500 /usr/local/bin/node",
  "  700   600 /usr/local/bin/bun",
  "  800   700 /opt/homebrew/bin/python3.12",
  "  900   800 /usr/bin/node",
].join("\n");

/** `ps -o pid=,args= -p ...` rows for the interpreters of TABLE. */
const ARGS: Readonly<Record<number, string>> = {
  200: "bun /Users/someone/tools/tern/cli.ts",
  600: "node /usr/lib/node_modules/pkg/bin/gemini.js --flag",
  700: "bun run /home/u/opencode.ts",
  800: "python3.12 -u /home/u/hermes.py",
  900: "node --inspect",
};

function readArgs(pids: readonly number[]): string {
  return pids
    .flatMap((pid) => (pid in ARGS ? [`${pid} ${ARGS[pid]}`] : []))
    .join("\n");
}

const never = () => {
  throw new Error("command lines were read");
};

describe("walkProcessChain", () => {
  it("lists the names from the start process upward, nearest first, stopping before init", () => {
    expect(walkProcessChain(TABLE, 500, readArgs)).toEqual([
      "sh",
      "cursor-agent",
      "zsh",
      "cli",
      "zsh",
    ]);
  });

  it("names a long program path with spaces by its basename", () => {
    const table = [
      "10 1 /Users/a person/Applications/Some Tool.app/Contents/MacOS/some-runtime",
      "11 10 /bin/zsh",
    ].join("\n");
    expect(walkProcessChain(table, 11, never)).toEqual(["zsh", "some-runtime"]);
    expect(
      walkProcessChain(
        "11 10 /bin/sh\n10 1 /Users/a person/very long folder/tool/tern",
        11,
        never,
      ),
    ).toEqual(["sh", "tern"]);
  });

  it("names an interpreter's process by its script, without flags, verbs or extension", () => {
    expect(walkProcessChain(TABLE, 600, readArgs)).toEqual([
      "gemini",
      "sh",
      "cursor-agent",
      "zsh",
      "cli",
      "zsh",
    ]);
    expect(walkProcessChain(TABLE, 700, readArgs)[0]).toBe("opencode");
    expect(walkProcessChain(TABLE, 800, readArgs)[0]).toBe("hermes");
  });

  it("asks for command lines once, for the interpreters only", () => {
    const asked: (readonly number[])[] = [];
    walkProcessChain(TABLE, 500, (pids) => {
      asked.push(pids);
      return readArgs(pids);
    });
    expect(asked).toEqual([[200]]);
  });

  it("reads no command lines when no interpreter is on the chain", () => {
    expect(
      walkProcessChain(
        "11 10 /bin/sh\n10 1 /Users/x/.local/bin/codex",
        11,
        never,
      ),
    ).toEqual(["sh", "codex"]);
  });

  it("keeps the interpreter's own name when it runs no script or its command line is unreadable", () => {
    expect(walkProcessChain(TABLE, 900, readArgs)[0]).toBe("node");
    expect(walkProcessChain(TABLE, 600, never)[0]).toBe("node");
  });

  it("follows at most MAX_CHAIN_DEPTH parents", () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => `${i + 2} ${i + 1} /bin/zsh`,
    ).join("\n");
    expect(walkProcessChain(rows, 41, never)).toHaveLength(MAX_CHAIN_DEPTH);
  });

  it("stops at a missing parent and at a cycle, and ignores junk lines", () => {
    expect(walkProcessChain("10 99 /bin/sh\nnot a row\n", 10, never)).toEqual([
      "sh",
    ]);
    expect(
      walkProcessChain("10 11 /bin/sh\n11 10 /bin/zsh", 10, never),
    ).toEqual(["sh", "zsh"]);
    expect(walkProcessChain("", 10, never)).toEqual([]);
  });

  it("names a login shell by its program", () => {
    expect(walkProcessChain("10 1 -zsh", 10, never)).toEqual(["zsh"]);
  });
});
