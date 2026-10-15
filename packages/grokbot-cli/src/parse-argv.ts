import { type Command, listCommands } from "grokbot-core";
import { argvParser, type Invocation } from "./argv-parser.js";

export type { Invocation };

/** Parses `grokbot` argv against the whole catalog, built once at load. */
export const parseArgv: (argv: readonly string[]) => Invocation = argvParser(
  listCommands(),
);

/** Rewrites a parseCommandInput error to CLI terms: `--name` for flags, `<name>` for arguments. */
export function cliError(command: Command, message: string): string {
  const prefix = `${command.name}: `;
  const body = message.startsWith(prefix)
    ? message.slice(prefix.length)
    : message;
  return body.replace(/parameter "([^"]+)"/g, (_, key: string) =>
    command.params[key]?.position === undefined
      ? `flag --${key}`
      : `argument <${key}>`,
  );
}
