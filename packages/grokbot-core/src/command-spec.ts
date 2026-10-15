import { GrokBotError } from "./contracts.js";
import type { GATEWAY_METHOD_SAFETY } from "./method-safety.js";
import type { SERVER_METHOD_SAFETY } from "./method-safety-table.js";

/** Parsed value of each param type. */
export interface ParamValueTypes {
  readonly string: string;
  readonly integer: number;
  readonly boolean: boolean;
  /** CLI: a repeated or comma-separated flag. MCP: an array of strings. */
  readonly "string-list": readonly string[];
}
export type ParamType = keyof ParamValueTypes;
export type ParamValue = ParamValueTypes[ParamType];

type Presence<T> =
  | { readonly required: true; readonly default?: never }
  | { readonly required?: false; readonly default?: T };

export type ParamSpec = {
  readonly description: string;
  /** Index among the command's positional CLI arguments. */
  readonly position?: number;
  /** Short CLI flag without dashes, e.g. "n" for -n. */
  readonly alias?: string;
} & (
  | ({ readonly type: "string" } & Presence<string>)
  | ({ readonly type: "integer"; readonly minimum?: number } & Presence<number>)
  | ({ readonly type: "boolean" } & Presence<boolean>)
  // A list is a flag only: a positional list would need variadic argv.
  | ({
      readonly type: "string-list";
      readonly position?: never;
    } & Presence<never>)
);

export const AGENT_PARAM = {
  type: "string",
  description: "Agent name, slug, or agentId (defaults to GROKBOT_AGENT)",
} as const;
export const JSON_PARAM = {
  type: "boolean",
  description: "Return machine-readable JSON",
  default: false,
} as const;
/** The confirmation every destructive or sensitive command declares as `yes`. */
export const YES_PARAM = {
  type: "boolean",
  description: "Confirm a command that changes or deletes live data",
  default: false,
} as const;

type ConfirmedSafety = "destructive" | "sensitive";
export type CommandSafety = "read-only" | "writes" | ConfirmedSafety;

export type ParamTable = Readonly<Record<string, ParamSpec>>;

interface SpecFields {
  readonly summary: string;
  /** aiserver.v1.GrokBotService methods the command calls. */
  readonly methods: readonly (keyof typeof SERVER_METHOD_SAFETY)[];
  /** Box Gateway methods the command calls. The EnsureSandBox the gateway runs first does not count toward `safety`. */
  readonly gatewayMethods?: readonly (keyof typeof GATEWAY_METHOD_SAFETY)[];
}

/**
 * `safety` is the worst tag among the command's methods; a destructive or sensitive
 * command must declare `yes`. Param insertion order is the order of CLI help and JSON Schema.
 */
export type CommandSpec = SpecFields &
  (
    | { readonly safety: "read-only" | "writes"; readonly params: ParamTable }
    | {
        readonly safety: ConfirmedSafety;
        readonly params: ParamTable & { readonly yes: typeof YES_PARAM };
      }
  );

/**
 * The transport `confirmed` flag for one run: true only for a destructive or sensitive
 * command run with `yes`. Without `yes` such a command throws before any network call.
 */
export function confirmedFor(
  name: string,
  safety: CommandSafety,
  input: object,
): boolean {
  if (safety === "read-only" || safety === "writes") return false;
  if ("yes" in input && input.yes === true) return true;
  throw new GrokBotError(
    "safety",
    `${name} changes or deletes live data. Re-run with --yes.`,
  );
}
