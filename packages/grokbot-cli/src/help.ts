import {
  type Command,
  GROKBOT_VERSION,
  listCommands,
  type ParamSpec,
} from "grokbot-core";
import { AUTH_COMMANDS } from "./auth-command.js";
import {
  flagParams,
  type ParamEntry,
  positionalParams,
  takesValue,
} from "./command-params.js";
import { CONFIG_SUMMARY } from "./config-command.js";

function valueLabel(spec: ParamSpec): string {
  if (!takesValue(spec)) return "";
  return spec.type === "string-list" ? " <string>..." : ` <${spec.type}>`;
}

function flagLabel([key, spec]: ParamEntry, withAlias: "short" | "both") {
  const value = valueLabel(spec);
  if (!spec.alias) return `--${key}${value}`;
  return withAlias === "short"
    ? `-${spec.alias}${value}`
    : `-${spec.alias}, --${key}${value}`;
}

function notes(spec: ParamSpec): string {
  const parts: string[] = [];
  if (spec.required) parts.push("required");
  if (spec.default !== undefined) parts.push(`default: ${spec.default}`);
  if (spec.type === "integer" && spec.minimum !== undefined)
    parts.push(`min: ${spec.minimum}`);
  if (spec.type === "string-list") parts.push("repeat or comma-separate");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Two-column block; the first column pads to its widest cell. */
function columns(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

export function usageLine(command?: Command): string {
  if (!command) {
    return "Usage: grokbot <command> [arguments] [flags] (grokbot --help lists the commands)";
  }
  const args = positionalParams(command).map(([key, spec]) =>
    spec.required ? `<${key}>` : `[${key}]`,
  );
  const flags = flagParams(command).map(
    (entry) => `[${flagLabel(entry, "short")}]`,
  );
  return ["Usage: grokbot", command.name, ...args, ...flags].join(" ");
}

export function generalHelp(): string {
  const commands = listCommands().map(
    (c) => [c.name, c.summary] as [string, string],
  );
  const account = Object.entries(AUTH_COMMANDS) as [string, string][];
  return [
    `grokbot ${GROKBOT_VERSION}. Orchestrate your GrokBot workforce from any terminal.`,
    "",
    "Usage: grokbot <command> [arguments] [flags]",
    "",
    "Commands:",
    ...columns(commands),
    "",
    "Account:",
    ...columns(account),
    "",
    "Settings:",
    ...columns([["config", CONFIG_SUMMARY]]),
    "",
    "Flags go before or after the command. Commands with an --agent flag fall",
    "back to GROKBOT_AGENT. Workforce commands (update, fire, room-members,",
    "skills-*, routines-*) take the bot as their first argument instead.",
    'Put -- before text that starts with a dash: grokbot ask -- "-5 is my answer"',
    "With --json, stdout is one JSON document; the job id and errors still go",
    "to stderr as plain text.",
    "Run grokbot <command> --help for its arguments, grokbot --version for the version.",
    "",
  ].join("\n");
}

export function commandHelp(command: Command): string {
  const describe = ([, spec]: ParamEntry) => spec.description + notes(spec);
  const args = positionalParams(command).map(
    (entry) => [`<${entry[0]}>`, describe(entry)] as [string, string],
  );
  const flags = flagParams(command).map(
    (entry) => [flagLabel(entry, "both"), describe(entry)] as [string, string],
  );
  return [
    command.summary,
    "",
    usageLine(command),
    "",
    ...(args.length > 0 ? ["Arguments:", ...columns(args), ""] : []),
    ...(flags.length > 0 ? ["Flags:", ...columns(flags), ""] : []),
  ].join("\n");
}
