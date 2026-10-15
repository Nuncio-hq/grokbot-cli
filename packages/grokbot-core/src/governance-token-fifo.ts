import { closeSync, constants, openSync } from "node:fs";
import { open } from "node:fs/promises";

export interface TokenFifoServer {
  /** How many times a reader was handed the token. */
  readonly serves: number;
  /** Stops serving and hands any reader still waiting an empty read. Synchronous for exit hooks. */
  stop(): void;
}

export interface TokenFifoOptions {
  readonly intervalMs?: number;
  /** Pause after a serve, so a reader still draining the pipe never gets the token twice. */
  readonly coolDownMs?: number;
  /** Reads served back to back at start. */
  readonly freeServes?: number;
  /** After the free reads, at most one read per window. */
  readonly windowMs?: number;
}

const WRITE_IF_READER = constants.O_WRONLY | constants.O_NONBLOCK;

/**
 * Serves a token through a named pipe, so a child reading `--auth-token-file <fifo>` gets it
 * and nothing is stored on disk. Each tick tries a non-blocking write-open, which succeeds
 * only while a reader waits, writes the current token (read fresh), and closes for EOF.
 *
 * Any process of this user could read the pipe, so serves are budgeted. `cursor-agent worker`
 * (v2026.10.01) reads the file with readFileSync at its startup check and again before every
 * connect, so the two free serves cover start. A held read blocks the worker until served;
 * its reconnects come in bursts (this Mac's worker logs: 98% within 60s of the previous), so a
 * one-minute window paces a reconnect storm without stalling a worker for long.
 */
export function serveTokenFifo(
  path: string,
  readToken: () => Promise<string>,
  {
    intervalMs = 50,
    coolDownMs = 500,
    freeServes = 2,
    windowMs = 60_000,
  }: TokenFifoOptions = {},
): TokenFifoServer {
  let busy = false;
  let stopped = false;
  let serves = 0;
  let lastServeAt = 0;
  const tick = async () => {
    if (busy || stopped) return;
    if (serves >= freeServes && Date.now() - lastServeAt < windowMs) return;
    busy = true;
    try {
      const handle = await open(path, WRITE_IF_READER).catch(() => undefined);
      if (handle === undefined) return;
      try {
        const token = await readToken();
        if (stopped) return;
        await handle.writeFile(`${token}\n`);
        serves += 1;
        lastServeAt = Date.now();
      } catch {
        // The reader then sees an empty file and the worker exits with its own auth error.
      } finally {
        await handle.close();
      }
      await new Promise((resolve) => setTimeout(resolve, coolDownMs));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return {
    get serves() {
      return serves;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        closeSync(openSync(path, WRITE_IF_READER));
      } catch {
        // No reader is waiting, or the pipe is already gone.
      }
    },
  };
}
