import type { CommandName, CommandOutputs } from "grokbot-core";

export type ToolSummary<N extends CommandName> = (
  output: CommandOutputs[N],
) => string;

/** One command group's tools/call summaries, exhaustive over the group's names. */
export type ToolSummaries<Names extends CommandName> = {
  readonly [N in Names]: ToolSummary<N>;
};

/** How one tool differs from its catalog entry. */
export interface McpOverride {
  readonly note?: string;
  /** Replaces catalog defaults when the client leaves the param out. */
  readonly defaults?: Readonly<Record<string, number | string>>;
  readonly destructive?: true;
  /** Params an MCP client may never set (hidden from the schema, refused on call). */
  readonly hiddenParams?: readonly string[];
  /** The command is not offered over MCP at all (CLI only). */
  readonly cliOnly?: true;
}

export type McpOverrides<Names extends CommandName> = {
  readonly [N in Names]?: McpOverride;
};

export const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export const waitHint = (jobId: string) =>
  `call grokbot_wait with ${JSON.stringify({ job: jobId })}`;

/** What to do after a send whose answer is not in yet, for an agent calling tools: the job id's first 8 characters are what `grokbot_inbox_wait` takes. */
export const inboxWaitHint = (jobId: string) =>
  `For anything the bot leaves later, call grokbot_inbox_wait with ${JSON.stringify({ job: [jobId.slice(0, 8)] })}.`;
