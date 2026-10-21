import {
  type Command,
  type CommandJsonSchema,
  type CommandName,
  type CommandRunner,
  type CommandSafety,
  describeNotice,
  GrokBotError,
  isCommandName,
  listCommands,
  paramsJsonSchema,
  parseCommandInput,
} from "grokbot-core";
import { invalidParams, isJsonObject, type Outcome } from "./json-rpc.js";
import type { McpOverride, McpOverrides } from "./mcp-tool-parts.js";
import { DISPATCH_OVERRIDES } from "./mcp-tools-dispatch.js";
import { GOVERNANCE_OVERRIDES } from "./mcp-tools-governance.js";
import { INBOX_OVERRIDES } from "./mcp-tools-inbox.js";
import { WORKFORCE_OVERRIDES } from "./mcp-tools-workforce.js";
import { summarize } from "./tool-summaries.js";

const TOOL_PREFIX = "grokbot_";

interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: CommandJsonSchema;
  readonly annotations: ToolAnnotations;
}

interface CallToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: object;
  readonly isError?: true;
}

const SAFETY: Record<
  CommandSafety,
  { readonly note?: string; readonly annotations: ToolAnnotations }
> = {
  "read-only": {
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  writes: {
    note: "Writes: changes state on a live GrokBot agent",
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  destructive: {
    note: "Destructive: deletes live GrokBot data; pass yes: true only after the owner approves",
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  sensitive: {
    note: "Sensitive: acts with the owner's authority; pass yes: true only after the owner approves",
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
};

const MCP_OVERRIDES: McpOverrides<CommandName> = {
  ...DISPATCH_OVERRIDES,
  ...WORKFORCE_OVERRIDES,
  ...GOVERNANCE_OVERRIDES,
  ...INBOX_OVERRIDES,
};

/** Params never offered over MCP: `json` (results are always structured) plus the tool's hidden ones. */
const hiddenOver = (override?: McpOverride): ReadonlySet<string> =>
  new Set(["json", ...(override?.hiddenParams ?? [])]);

/** MCP results are always structured, so the CLI-only `json` flag is dropped. */
function inputSchema(
  command: Command,
  override?: McpOverride,
): CommandJsonSchema {
  const defaults = override?.defaults ?? {};
  const hidden = hiddenOver(override);
  const schema = paramsJsonSchema(command.params);
  const properties = Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([key]) => !hidden.has(key))
      .map(([key, prop]) => {
        const value = defaults[key];
        return [key, value === undefined ? prop : { ...prop, default: value }];
      }),
  );
  const required = schema.required?.filter((key) => !hidden.has(key));
  const { required: _drop, ...rest } = schema;
  return {
    ...rest,
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

/** `room-create` -> `grokbot_room_create`: one separator style across every MCP tool name. */
export function toolName(command: CommandName): string {
  return `${TOOL_PREFIX}${command.replaceAll("-", "_")}`;
}

/** Inverse of `toolName`; undefined for anything that is not a catalog tool. */
export function commandForTool(tool: string): CommandName | undefined {
  if (!tool.startsWith(TOOL_PREFIX)) return undefined;
  const command = tool.slice(TOOL_PREFIX.length).replaceAll("_", "-");
  return isCommandName(command) && toolName(command) === tool
    ? command
    : undefined;
}

/** The tools/list entry of one catalog command. */
export function mcpTool(command: Command, override?: McpOverride): McpTool {
  const { name, summary, safety } = command;
  const notes = [SAFETY[safety].note, override?.note].filter(
    (note): note is string => note !== undefined,
  );
  const { annotations } = SAFETY[safety];
  return {
    name: toolName(name),
    description:
      notes.length === 0 ? summary : `${[summary, ...notes].join(". ")}.`,
    inputSchema: inputSchema(command, override),
    annotations: override?.destructive
      ? { ...annotations, destructiveHint: true }
      : annotations,
  };
}

export function mcpTools(): readonly McpTool[] {
  return listCommands()
    .filter((command) => !MCP_OVERRIDES[command.name]?.cliOnly)
    .map((command) => mcpTool(command, MCP_OVERRIDES[command.name]));
}

const isBlank = (value: unknown) =>
  value === undefined || (typeof value === "string" && !value.trim());

function withMcpDefaults(
  name: CommandName,
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const defaults = Object.entries(MCP_OVERRIDES[name]?.defaults ?? {});
  const missing = defaults.filter(([key]) => isBlank(args[key]));
  return missing.length > 0
    ? { ...args, ...Object.fromEntries(missing) }
    : args;
}

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

async function runTool<N extends CommandName>(
  name: N,
  args: Readonly<Record<string, unknown>>,
  runner: CommandRunner,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const hidden = [...hiddenOver(MCP_OVERRIDES[name])].filter(
    (key) => key !== "json" && args[key] !== undefined,
  );
  if (hidden.length > 0) {
    return errorResult(
      `${toolName(name)}: ${hidden.join(", ")} cannot be set over MCP; use the grokbot CLI.`,
    );
  }
  const parsed = parseCommandInput(name, withMcpDefaults(name, args));
  if (!parsed.ok) return errorResult(parsed.errors.join("\n"));
  try {
    const output = await runner.run(name, parsed.input, { signal });
    return {
      content: [
        { type: "text", text: summarize(name, output) },
        // What the bots left this session since it last looked, as one more block.
        ...(output.inboxNotice === undefined
          ? []
          : [
              {
                type: "text" as const,
                text: describeNotice(output.inboxNotice.items),
              },
            ]),
      ],
      structuredContent: output,
    };
  } catch (error) {
    if (error instanceof GrokBotError) return errorResult(error.message);
    throw error;
  }
}

/** `tools/call`: bad tool names are protocol errors; bad arguments and GrokBot failures are tool errors. */
export async function callTool(
  params: Readonly<Record<string, unknown>>,
  runner: CommandRunner,
  signal: AbortSignal,
): Promise<Outcome> {
  const { name, arguments: args = {} } = params;
  if (typeof name !== "string") {
    return { error: invalidParams("name must be a string") };
  }
  if (!isJsonObject(args)) {
    return { error: invalidParams("arguments must be an object") };
  }
  const command = commandForTool(name);
  if (command === undefined || MCP_OVERRIDES[command]?.cliOnly) {
    return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  return { result: await runTool(command, args, runner, signal) };
}
