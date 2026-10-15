import type { Command } from "grokbot-core";
import { flagParams, positionalParams, takesValue } from "./command-params.js";

export type Invocation =
  | { readonly kind: "help"; readonly command?: Command }
  | { readonly kind: "version" }
  | {
      readonly kind: "usage-error";
      readonly command?: Command;
      readonly errors: readonly string[];
    }
  | {
      readonly kind: "run";
      readonly command: Command;
      /** Raw values keyed by param name, ready for parseCommandInput. */
      readonly raw: Readonly<Record<string, unknown>>;
      readonly json: boolean;
    };

interface FlagSpec {
  readonly key: string;
  readonly takesValue: boolean;
  /** A string-list flag: repeats accumulate and each value splits on commas. */
  readonly list: boolean;
}

interface FlagHit {
  readonly token: string;
  readonly flag: FlagSpec | undefined;
  /** Text after `=` in `--name=value`. */
  readonly inline: string | undefined;
  readonly value: string | undefined;
}

const HELP = "help";
const VERSION = "version";

/**
 * Every flag token any command accepts, plus help and version. Flags may come before
 * the command, so value-taking must be known before the command is.
 */
function flagTable(commands: Iterable<Command>): ReadonlyMap<string, FlagSpec> {
  const table = new Map<string, FlagSpec>();
  const add = (token: string, flag: FlagSpec) => {
    const seen = table.get(token);
    if (
      seen &&
      (seen.key !== flag.key ||
        seen.takesValue !== flag.takesValue ||
        seen.list !== flag.list)
    )
      throw new Error(`catalog flag ${token} has two meanings`);
    table.set(token, flag);
  };
  for (const [token, key] of [
    ["--help", HELP],
    ["-h", HELP],
    ["--version", VERSION],
    ["-v", VERSION],
  ] as const) {
    add(token, { key, takesValue: false, list: false });
  }
  for (const command of commands) {
    for (const [key, spec] of flagParams(command)) {
      const flag = {
        key,
        takesValue: takesValue(spec),
        list: spec.type === "string-list",
      };
      add(`--${key}`, flag);
      if (spec.alias) add(`-${spec.alias}`, flag);
    }
  }
  return table;
}

const looksLikeFlag = (token: string) =>
  token.startsWith("-") && token.length > 1;

function scan(argv: readonly string[], flags: ReadonlyMap<string, FlagSpec>) {
  const positionals: string[] = [];
  const hits: FlagHit[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!looksLikeFlag(token)) {
      positionals.push(token);
      continue;
    }
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq < 0 ? token : token.slice(0, eq);
    const inline = eq < 0 ? undefined : token.slice(eq + 1);
    const flag = flags.get(name);
    let value = inline;
    const next = argv[i + 1];
    if (flag?.takesValue && value === undefined && next !== undefined) {
      if (!looksLikeFlag(next)) {
        value = next;
        i++;
      }
    }
    hits.push({ token: name, flag, inline, value });
  }
  return { positionals, hits };
}

/** `a, b,,c` is three items; blanks drop so a trailing comma is harmless. */
const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

function unknownCommand(name: string): Invocation {
  return {
    kind: "usage-error",
    errors: [`unknown command ${JSON.stringify(name)}`],
  };
}

/** Raw param values from one command's flags and positionals, or its usage errors. */
function collect(
  command: Command,
  hits: readonly FlagHit[],
  rest: readonly string[],
): Invocation {
  const errors: string[] = [];
  const raw: Record<string, unknown> = {};
  const lists = new Map<string, string[]>();
  const takesText = command.params.text?.required === true;
  const dashHint = takesText
    ? " (put -- before text that starts with a dash)"
    : "";
  for (const { token, flag, inline, value } of hits) {
    const spec = flag && command.params[flag.key];
    if (!flag || !spec || spec.position !== undefined) {
      errors.push(`unknown flag ${token}${dashHint}`);
    } else if (flag.takesValue && value === undefined) {
      errors.push(`${token} needs a value`);
    } else if (!flag.takesValue && inline !== undefined) {
      errors.push(`${token} does not take a value`);
    } else if (flag.list) {
      const items = lists.get(flag.key) ?? [];
      lists.set(flag.key, [...items, ...splitList(value ?? "")]);
    } else {
      raw[flag.key] = value ?? true;
    }
  }
  for (const [key, items] of lists) raw[key] = items;
  const slots = positionalParams(command);
  rest.forEach((value, i) => {
    const slot = slots[i];
    if (slot) raw[slot[0]] = value;
    else errors.push(`unexpected argument ${JSON.stringify(value)}`);
  });
  if (errors.length > 0) return { kind: "usage-error", command, errors };
  return { kind: "run", command, raw, json: raw.json === true };
}

/**
 * An argv parser over a fixed command list. The first non-flag token is the command;
 * flags may sit anywhere before `--`. Throws when two commands give one flag two meanings.
 */
export function argvParser(
  commands: readonly Command[],
): (argv: readonly string[]) => Invocation {
  const byName = new Map<string, Command>(commands.map((c) => [c.name, c]));
  const flags = flagTable(commands);
  const helpFor = (topic: string | undefined): Invocation => {
    if (topic === undefined) return { kind: "help" };
    const command = byName.get(topic);
    return command ? { kind: "help", command } : unknownCommand(topic);
  };
  return (argv) => {
    const { positionals, hits } = scan(argv, flags);
    const [first, ...rest] = positionals;
    const has = (key: string) => hits.some((hit) => hit.flag?.key === key);
    if (first === HELP) return helpFor(rest[0]);
    if (has(HELP)) return helpFor(first);
    if (has(VERSION)) return { kind: "version" };
    if (first === undefined) {
      return argv.length === 0
        ? { kind: "help" }
        : { kind: "usage-error", errors: ["missing command"] };
    }
    const command = byName.get(first);
    return command ? collect(command, hits, rest) : unknownCommand(first);
  };
}
