#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createCommandRunner,
  detectClient,
  GROKBOT_VERSION,
  readProcessChain,
  usageEnabled,
  withUsageLog,
} from "grokbot-core";
import { main } from "./main.js";

async function run(): Promise<void> {
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  // A person types in a terminal; an agent's shell has no TTY on stdin.
  const caller = detectClient({
    env: process.env,
    isTTY: process.stdin.isTTY === true,
    processChain: readProcessChain,
  });
  const code = await main(process.argv.slice(2), {
    createRunner: (options) =>
      withUsageLog(createCommandRunner({ ...options, caller: caller.label }), {
        surface: "cli",
        version: GROKBOT_VERSION,
        client: () => caller.label,
        enabled: () => usageEnabled(process.env),
      }),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    isTTY: process.stderr.isTTY === true,
    caller,
    signal: interrupt.signal,
  });
  process.exitCode = code;
  if (interrupt.signal.aborted) process.exit(code);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === fileURLToPath(import.meta.url)
) {
  await run();
}
