import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withAgentLock } from "./agent-lock.js";
import { GrokBotError } from "./contracts.js";

const AGENT = "f882ec52-17b1-4639-b0fc-07fed7526b09";
/** Far above any pid macOS or Linux hands out, so no process has it. */
const DEAD_PID = 2_147_483_000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withAgentLock", () => {
  it("runs holders one at a time and removes the lock file after", async () => {
    const trace: string[] = [];
    const hold = (name: string) =>
      withAgentLock(dir, AGENT, async () => {
        trace.push(`${name} in`);
        await delay(30);
        trace.push(`${name} out`);
      });
    await Promise.all([hold("a"), hold("b")]);
    expect([trace.slice(0, 2), trace.slice(2), await readdir(dir)]).toEqual([
      [trace[0], trace[0]?.replace("in", "out")],
      [trace[2], trace[2]?.replace("in", "out")],
      [],
    ]);
  });

  it("releases the lock when the holder throws", async () => {
    const failed = withAgentLock(dir, AGENT, async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect(await withAgentLock(dir, AGENT, async () => "next")).toBe("next");
  });

  it("takes over a lock left by a process that died", async () => {
    await writeFile(join(dir, `.lock-${AGENT}`), `${DEAD_PID}\n`);
    expect(await withAgentLock(dir, AGENT, async () => "ran")).toBe("ran");
  });

  it("refuses an agent id that is not a safe file name", async () => {
    const error = await withAgentLock(dir, "../x", async () => 1).catch(
      (e: unknown) => e,
    );
    expect(error instanceof GrokBotError && error.code).toBe("protocol");
  });
});
