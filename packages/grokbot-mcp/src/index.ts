#!/usr/bin/env node
import {
  type CommandRunner,
  createCommandRunner,
  GROKBOT_VERSION,
} from "grokbot-core";
import { serve } from "./server.js";

// Built on the first tools/call, so initialize and tools/list never read the Keychain.
let runner: CommandRunner | undefined;
const lazyRunner: CommandRunner = {
  run: (name, input, options) => {
    runner ??= createCommandRunner({
      defaultAgent: process.env.GROKBOT_AGENT,
    });
    return runner.run(name, input, options);
  },
};

const log = (line: string) => process.stderr.write(`grokbot-mcp: ${line}\n`);

log(`v${GROKBOT_VERSION} serving MCP on stdio`);
await serve({
  input: process.stdin,
  output: process.stdout,
  runner: lazyRunner,
  log,
});
