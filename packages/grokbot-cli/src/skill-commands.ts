import { type Command, type CommandSafety, listCommands } from "grokbot-core";
import { spokenName } from "./argv-parser.js";
import {
  AUTH_COMMANDS,
  AUTH_HELP,
  type AuthCommandName,
} from "./auth-command.js";
import {
  flagParams,
  type ParamEntry,
  positionalParams,
  takesValue,
} from "./command-params.js";
import { STATS_HELP, STATS_SUMMARY } from "./stats-command.js";

export const TABLE_START =
  "<!-- BEGIN generated command table: bun run gen:skill -->";
export const TABLE_END = "<!-- END generated command table -->";

const SAFETY_LABEL: { readonly [S in CommandSafety]: string } = {
  "read-only": "read-only",
  writes: "writes",
  destructive: "destructive, needs --yes",
  sensitive: "sensitive, needs --yes",
};

const cell = (text: string) => text.replaceAll("|", "\\|");
const row = (usage: string, safety: string, summary: string) =>
  `| \`${cell(usage)}\` | ${safety} | ${cell(summary)} |`;

function flag([key, spec]: ParamEntry): string {
  const name = spec.alias ? `-${spec.alias}` : `--${key}`;
  const value = !takesValue(spec)
    ? ""
    : spec.type === "string-list"
      ? " <string>..."
      : ` <${spec.type}>`;
  return spec.required ? `${name}${value}` : `[${name}${value}]`;
}

/** Every command takes --json, so the table leaves it out and the skill says so once. */
function catalogRow(command: Command): string {
  const args = positionalParams(command).map(([key, spec]) =>
    spec.required ? `<${key}>` : `[${key}]`,
  );
  const flags = flagParams(command)
    .filter(([key]) => key !== "json")
    .map(flag);
  const usage = ["grokbot", spokenName(command.name), ...args, ...flags].join(
    " ",
  );
  return row(usage, SAFETY_LABEL[command.safety], command.summary);
}

function accountRow(name: AuthCommandName): string {
  const usage = (AUTH_HELP[name].split("\n")[2] ?? "")
    .replace("Usage: ", "")
    .replace(" [--json]", "");
  return row(usage, "account, local only", AUTH_COMMANDS[name]);
}

const ACCOUNT = Object.keys(AUTH_COMMANDS) as AuthCommandName[];

/** `grokbot stats`: local like the account commands, listed so agents can read their own usage. */
const STATS_ROW = row(
  (STATS_HELP.split("\n")[2] ?? "")
    .replace("Usage: ", "")
    .replace(" [--json]", ""),
  "local; --bots reads GrokBot",
  STATS_SUMMARY,
);

/** The SKILL.md command table: catalog commands in catalog order, the account commands, then stats. */
export function renderCommandTable(
  commands: readonly Command[] = listCommands(),
  account: readonly AuthCommandName[] = ACCOUNT,
  withStats = true,
): string {
  return [
    "| Command | Safety | What it does |",
    "| --- | --- | --- |",
    ...commands.map(catalogRow),
    ...account.map(accountRow),
    ...(withStats ? [STATS_ROW] : []),
    "",
  ].join("\n");
}

/** Replaces the text between the table markers; everything else stays byte for byte. */
export function spliceCommandTable(skill: string, table: string): string {
  const start = skill.indexOf(TABLE_START);
  const end = skill.indexOf(TABLE_END, start);
  if (start < 0 || end < 0) {
    throw new Error(
      `SKILL.md has no generated command table. Add ${TABLE_START} and ${TABLE_END} on their own lines.`,
    );
  }
  return `${skill.slice(0, start + TABLE_START.length)}\n${table}${skill.slice(end)}`;
}
