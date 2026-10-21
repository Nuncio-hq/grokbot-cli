import type {
  CommandSpec,
  ParamTable,
  ParamType,
  ParamValueTypes,
} from "./command-spec.js";
import { DISPATCH_COMMANDS } from "./command-specs-dispatch.js";
import { GOVERNANCE_COMMANDS } from "./command-specs-governance.js";
import { INBOX_COMMANDS } from "./command-specs-inbox.js";
import { WORKFORCE_COMMANDS } from "./command-specs-workforce.js";

type CommandGroup = Readonly<Record<string, CommandSpec>>;

/** Joins the four command groups in order; throws when two groups define one name. */
export function mergeCommandGroups<
  D extends CommandGroup,
  W extends CommandGroup,
  G extends CommandGroup,
  I extends CommandGroup,
>(dispatch: D, workforce: W, governance: G, inbox: I): D & W & G & I {
  const owner = new Map<string, string>();
  for (const [group, specs] of Object.entries({
    dispatch,
    workforce,
    governance,
    inbox,
  })) {
    for (const name of Object.keys(specs)) {
      const first = owner.get(name);
      if (first !== undefined) {
        throw new Error(
          `Command "${name}" is defined in both the ${first} and ${group} groups.`,
        );
      }
      owner.set(name, group);
    }
  }
  return { ...dispatch, ...workforce, ...governance, ...inbox };
}

export const COMMANDS = mergeCommandGroups(
  DISPATCH_COMMANDS,
  WORKFORCE_COMMANDS,
  GOVERNANCE_COMMANDS,
  INBOX_COMMANDS,
);

export type CommandName = keyof typeof COMMANDS;

/** A catalog entry as hosts read it: the spec fields with a plain param table. */
export type Command = Omit<CommandSpec, "params"> & {
  readonly name: CommandName;
  readonly params: ParamTable;
};

type ValueOf<P> = P extends { type: infer T extends ParamType }
  ? ParamValueTypes[T]
  : never;
type Fill<P> = P extends { required: true } | { default: unknown }
  ? "set"
  : "optional";
type KeysWhere<P extends ParamTable, F> = {
  [K in keyof P]: Fill<P[K]> extends F ? K : never;
}[keyof P];

/** Parsed input of a param table; params with a default are always set. */
export type InputOf<P extends ParamTable> = {
  readonly [K in KeysWhere<P, "set">]: ValueOf<P[K]>;
} & {
  readonly [K in KeysWhere<P, "optional">]?: ValueOf<P[K]>;
} extends infer T
  ? { [K in keyof T]: T[K] }
  : never;

/** Parsed input of a catalog command. */
export type CommandInput<N extends CommandName> = InputOf<
  (typeof COMMANDS)[N]["params"]
>;

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

export function listCommands(): readonly Command[] {
  return Object.keys(COMMANDS)
    .filter(isCommandName)
    .map((name) => ({ name, ...COMMANDS[name] }));
}
