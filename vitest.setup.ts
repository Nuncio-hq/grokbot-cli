import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file gets its own empty home, so defaults that read ~/.grokbot (project
// routes, protected bots, jobs, settings) never see the developer's real files.
process.env.HOME = mkdtempSync(join(tmpdir(), "grokbot-test-home-"));

// An agent that runs the tests exports its own session to every command; none of it may
// reach a message header or an inbox mark. Tests that need a session pass their own env.
for (const name of [
  "GROKBOT_SESSION",
  "CODEX_THREAD_ID",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
]) {
  delete process.env[name];
}
