import type { Command, ParamSpec } from "grokbot-core";

export type ParamEntry = readonly [key: string, spec: ParamSpec];

/** Positional params in argv order. */
export function positionalParams(command: Command): ParamEntry[] {
  return Object.entries(command.params)
    .filter(([, spec]) => spec.position !== undefined)
    .sort(([, a], [, b]) => (a.position ?? 0) - (b.position ?? 0));
}

/** Params passed as flags, in catalog order. */
export function flagParams(command: Command): ParamEntry[] {
  return Object.entries(command.params).filter(
    ([, spec]) => spec.position === undefined,
  );
}

export function takesValue(spec: ParamSpec): boolean {
  return spec.type !== "boolean";
}
