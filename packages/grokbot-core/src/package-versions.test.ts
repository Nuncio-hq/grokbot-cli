import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROKBOT_VERSION } from "./index.js";

const manifest = (dir: string) =>
  JSON.parse(
    readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8"),
  );

describe("release versions", () => {
  it("match across the three packages, their grokbot-core range and GROKBOT_VERSION", () => {
    const [core, cli, mcp] = ["grokbot-core", "grokbot-cli", "grokbot-mcp"].map(
      manifest,
    );
    expect(GROKBOT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect([core.version, cli.version, mcp.version]).toStrictEqual([
      GROKBOT_VERSION,
      GROKBOT_VERSION,
      GROKBOT_VERSION,
    ]);
    expect(cli.dependencies["grokbot-core"]).toBe(`^${GROKBOT_VERSION}`);
    expect(mcp.dependencies["grokbot-core"]).toBe(`^${GROKBOT_VERSION}`);
  });
});
