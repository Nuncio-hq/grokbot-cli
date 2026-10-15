#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCommandRunner } from "grokbot-core";
import { main } from "./main.js";

async function run(): Promise<void> {
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  const code = await main(process.argv.slice(2), {
    createRunner: (options) => createCommandRunner(options),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    isTTY: process.stderr.isTTY === true,
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
