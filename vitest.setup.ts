import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file gets its own empty home, so defaults that read ~/.grokbot (project
// routes, protected bots, jobs, settings) never see the developer's real files.
process.env.HOME = mkdtempSync(join(tmpdir(), "grokbot-test-home-"));
