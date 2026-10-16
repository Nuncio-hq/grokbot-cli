#!/usr/bin/env node
import {
  type CommandRunner,
  createCommandRunner,
  detectClient,
  GROKBOT_VERSION,
  usageEnabled,
  withUsageLog,
} from "grokbot-core";
import { mcpClientName } from "./mcp-client-name.js";
import { serve } from "./server.js";

// Built on the first tools/call, so initialize and tools/list never read the Keychain.
let runner: CommandRunner | undefined;
const lazyRunner: CommandRunner = {
  run: (name, input, options) => {
    runner ??= withUsageLog(
      createCommandRunner({ defaultAgent: process.env.GROKBOT_AGENT }),
      {
        surface: "mcp",
        version: GROKBOT_VERSION,
        client: () =>
          detectClient({
            env: process.env,
            isTTY: false,
            mcpClientName: mcpClientName(),
          }),
        enabled: () => usageEnabled(process.env),
      },
    );
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
