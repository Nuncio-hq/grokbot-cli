import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards "Any agent, any purpose" (AGENTS.md, docs Decision 08): shipped source and the
 * shipped skill never single out one agent runtime and never hold a bot's agentId.
 * Tests and fixtures are exempt: they may name runtimes and use placeholder ids.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKILL = "packages/grokbot-cli/skills/grokbot/SKILL.md";

/** Agent runtimes. Cursor is left out: GrokBot itself runs on Cursor's backend. */
const RUNTIMES = /\b(claude|codex|hermes|gemini|opencode)\b/gi;
const AGENT_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Files allowed to name one runtime alone, and why. */
const ONE_RUNTIME_ALLOWED: Readonly<Record<string, string>> = {
  "packages/grokbot-core/src/usage-client.ts":
    "detects callers from each runtime's own markers",
  "packages/grokbot-mcp/src/mcp-tools-dispatch.ts":
    "cites the MCP host whose tool-call limit was measured",
};

function shippedFiles(): string[] {
  const files: string[] = [SKILL];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    for (const entry of readdirSync(src, { recursive: true })) {
      const path = String(entry);
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
      if (path.split("/").includes("fixtures")) continue;
      files.push(relative(ROOT, join(src, path)));
    }
  }
  return files;
}

const linesOf = (file: string) =>
  readFileSync(join(ROOT, file), "utf8").split("\n");

const runtimesIn = (text: string) =>
  new Set([...text.matchAll(RUNTIMES)].map((m) => m[1]?.toLowerCase()));

describe("shipped source is agent- and account-neutral", () => {
  const files = shippedFiles();

  it("scans every package's source and the skill", () => {
    expect(files).toContain(SKILL);
    expect(files.some((f) => f.startsWith("packages/grokbot-mcp/src/"))).toBe(
      true,
    );
    for (const file of Object.keys(ONE_RUNTIME_ALLOWED))
      expect(files).toContain(file);
  });

  it("holds no agentId", () => {
    const hits = files.flatMap((file) =>
      linesOf(file).flatMap((line, i) =>
        AGENT_ID.test(line) ? [`${file}:${i + 1}`] : [],
      ),
    );
    expect(hits, "move bot ids into user config or test fixtures").toEqual([]);
  });

  it("names a runtime only beside others", () => {
    const hits = files
      .filter((file) => !(file in ONE_RUNTIME_ALLOWED))
      .flatMap((file) => {
        const lines = linesOf(file);
        return lines.flatMap((line, i) => {
          if (runtimesIn(line).size === 0) return [];
          // Wrapped help text splits a list over lines, so read the neighbours too.
          const near = lines.slice(Math.max(0, i - 1), i + 2).join(" ");
          return runtimesIn(near).size >= 2 ? [] : [`${file}:${i + 1}`];
        });
      });
    expect(hits, "list several runtimes or none").toEqual([]);
  });
});
