#!/usr/bin/env node
import {
  type CommandRunner,
  createCommandRunner,
  detectClient,
  GROKBOT_VERSION,
  readProcessChain,
  usageEnabled,
  withUsageLog,
} from "grokbot-core";
import { mcpClientName } from "./mcp-client-name.js";
import { MCP_INBOX_WAIT_MAX_SECONDS } from "./mcp-tools-inbox.js";
import { serve } from "./server.js";

// Built on the first tools/call, so initialize and tools/list never read the Keychain.
// The client names itself on initialize, before any tools/call, so its name is known then.
let runner: CommandRunner | undefined;
function createRunner(): CommandRunner {
  const caller = detectClient({
    env: process.env,
    isTTY: false,
    mcpClientName: mcpClientName(),
    processChain: readProcessChain,
  }).label;
  return withUsageLog(
    createCommandRunner({
      defaultAgent: process.env.GROKBOT_AGENT,
      caller,
      maxInboxWaitSeconds: MCP_INBOX_WAIT_MAX_SECONDS,
    }),
    {
      surface: "mcp",
      version: GROKBOT_VERSION,
      client: () => caller,
      enabled: () => usageEnabled(process.env),
    },
  );
}
const lazyRunner: CommandRunner = {
  run: (name, input, options) => {
    runner ??= createRunner();
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
