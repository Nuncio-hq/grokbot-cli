import type { CommandName, CommandOutput } from "grokbot-core";
import type { ToolSummaries, ToolSummary } from "./mcp-tool-parts.js";
import { DISPATCH_SUMMARIES } from "./mcp-tools-dispatch.js";
import { GOVERNANCE_SUMMARIES } from "./mcp-tools-governance.js";
import { INBOX_SUMMARIES } from "./mcp-tools-inbox.js";
import { WORKFORCE_SUMMARIES } from "./mcp-tools-workforce.js";

const SUMMARIES: ToolSummaries<CommandName> = {
  ...DISPATCH_SUMMARIES,
  ...WORKFORCE_SUMMARIES,
  ...GOVERNANCE_SUMMARIES,
  ...INBOX_SUMMARIES,
};

/** The text block of a tools/call result; the typed output rides in structuredContent. */
export function summarize<N extends CommandName>(
  name: N,
  output: CommandOutput<N>,
): string {
  const summary: ToolSummary<N> = SUMMARIES[name];
  return summary(output);
}
