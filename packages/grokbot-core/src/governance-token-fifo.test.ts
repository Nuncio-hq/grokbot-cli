import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveTokenFifo } from "./governance-token-fifo.js";

let path: string;
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), "grokbot-fifo-")), "token.fifo");
  await promisify(execFile)("mkfifo", ["-m", "600", path]);
});
afterEach(async () => {
  await rm(join(path, ".."), { recursive: true, force: true });
});

/** What a reader would get by waiting `waitMs` on the pipe without blocking on it. */
async function probe(waitMs: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

describe.skipIf(process.platform === "win32")("serveTokenFifo", () => {
  it("serves the free reads, then holds the next one until the window opens", async () => {
    let issued = 0;
    const server = serveTokenFifo(path, async () => `tok-${++issued}`, {
      intervalMs: 10,
      coolDownMs: 30,
      freeServes: 1,
      windowMs: 400,
    });
    try {
      const first = await readFile(path, "utf8");
      const servedAt = Date.now();
      const held = await probe(150);
      const second = await readFile(path, "utf8");
      const waited = Date.now() - servedAt >= 380;
      const info = await stat(path);
      expect([
        first,
        held,
        second,
        waited,
        server.serves,
        info.isFIFO(),
        info.size,
      ]).toEqual(["tok-1\n", "", "tok-2\n", true, 2, true, 0]);
    } finally {
      server.stop();
    }
  });

  it("serves the worker's startup check and first connect back to back by default", async () => {
    const server = serveTokenFifo(path, async () => "tok", {
      intervalMs: 10,
      coolDownMs: 30,
    });
    try {
      const reads = [
        await readFile(path, "utf8"),
        await readFile(path, "utf8"),
        await probe(150),
      ];
      expect([reads, server.serves]).toEqual([["tok\n", "tok\n", ""], 2]);
    } finally {
      server.stop();
    }
  });

  it("gives nothing once stopped", async () => {
    const server = serveTokenFifo(path, async () => "tok", {
      intervalMs: 10,
      coolDownMs: 30,
    });
    const first = await readFile(path, "utf8");
    server.stop();
    expect([first, await probe(100), server.serves]).toEqual(["tok\n", "", 1]);
  });
});
