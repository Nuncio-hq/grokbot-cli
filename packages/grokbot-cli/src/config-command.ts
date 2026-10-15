import {
  type CliConfig,
  cliConfigStore,
  credentialStore,
  isKeychainAccess,
  type KeychainAccess,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * `grokbot config`: grokbot's own local settings. CLI-only like login (no RPC, never
 * offered over MCP). Today one setting: who may read the saved sign-in without asking.
 */
export const CONFIG_SUMMARY =
  "Show or change grokbot's local settings (keychain-access)";

export const CONFIG_HELP = [
  CONFIG_SUMMARY,
  "",
  "Usage: grokbot config [keychain-access [silent|prompt]] [--json]",
  "",
  "keychain-access decides who may read grokbot login's sign-in from the macOS Keychain:",
  "  silent  Any program running as you, without a dialog (default). Needed for",
  "          grokbot-mcp and background agents.",
  "  prompt  macOS asks before each grokbot run reads it (one dialog per run).",
  "          Safer, but grokbot-mcp and background agents stall until you click.",
  "",
  "Changing it re-creates the saved sign-in with the new access; you stay signed in.",
  "Settings live in ~/.grokbot/grokbot-cli.json, which never holds a token.",
  "",
].join("\n");

const SETTING = "keychain-access";

/** Side effects of `grokbot config`, injectable so tests never touch the Keychain. */
export interface ConfigDeps {
  readonly path: string;
  read(): Promise<CliConfig>;
  write(config: CliConfig): Promise<void>;
  /** The saved sign-in's real mode (no token read), or undefined when none is saved. */
  itemAccess(): Promise<KeychainAccess | undefined>;
  setItemAccess(
    access: KeychainAccess,
  ): Promise<{ readonly migrated: boolean }>;
}

export function defaultConfigDeps(): ConfigDeps {
  const config = cliConfigStore();
  const store = credentialStore();
  return {
    path: config.path,
    read: () => config.read(),
    write: (next) => config.write(next),
    itemAccess: () => store.itemAccess(),
    setItemAccess: (access) => store.setAccess(access),
  };
}

interface ConfigContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly deps: ConfigDeps;
}

const usage = (stderr: TextSink, error: string) => {
  stderr.write(`grokbot: config: ${error}\n`);
  stderr.write(`${CONFIG_HELP.split("\n")[2]}\n`);
  return EXIT_CODE.usage;
};

/** Runs `grokbot config ...` and returns its exit code. Errors propagate to `main`. */
export async function runConfigCommand(
  args: readonly string[],
  ctx: ConfigContext,
): Promise<number> {
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const unknownFlag = words.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    return usage(ctx.stderr, `unknown flag "${unknownFlag.split("=", 1)[0]}"`);
  }
  const [setting, value, ...extra] = words;
  if (extra.length > 0) return usage(ctx.stderr, "too many arguments");
  if (setting !== undefined && setting !== SETTING) {
    return usage(
      ctx.stderr,
      `unknown setting "${setting}" (known: ${SETTING})`,
    );
  }
  if (value !== undefined && !isKeychainAccess(value)) {
    return usage(ctx.stderr, `${SETTING} must be "silent" or "prompt"`);
  }

  const { keychainAccess } = await ctx.deps.read();
  if (value === undefined) {
    const saved = await ctx.deps.itemAccess();
    if (json) {
      ctx.stdout.write(
        `${JSON.stringify({ keychainAccess, savedSignIn: saved ?? null, path: ctx.deps.path }, null, 2)}\n`,
      );
    } else if (setting) {
      ctx.stdout.write(`${keychainAccess}\n`);
    } else {
      const item = saved ? `(saved sign-in: ${saved})` : "(no saved sign-in)";
      ctx.stdout.write(
        `${SETTING}  ${keychainAccess}  ${item}\n\nSettings file: ${ctx.deps.path}\n`,
      );
    }
    return EXIT_CODE.ok;
  }

  const saved = await ctx.deps.itemAccess();
  if (value === keychainAccess && (saved === undefined || saved === value)) {
    ctx.stdout.write(
      json
        ? `${JSON.stringify({ keychainAccess: value, changed: false }, null, 2)}\n`
        : `${SETTING} is already ${value}.\n`,
    );
    return EXIT_CODE.ok;
  }
  // Move the saved sign-in first; if that fails, the old setting stays as it was.
  const { migrated } = await ctx.deps.setItemAccess(value);
  await ctx.deps.write({ keychainAccess: value });
  ctx.stdout.write(
    json
      ? `${JSON.stringify({ keychainAccess: value, changed: true, migrated }, null, 2)}\n`
      : `${SETTING} is now ${value}. ${migrated ? "The saved sign-in was moved to it." : "It applies to the next grokbot login."}\n`,
  );
  if (value === "prompt") {
    ctx.stderr.write(
      "Note: macOS will ask before grokbot reads the sign-in (one dialog per run). grokbot-mcp and background agents will wait for that dialog; switch back with grokbot config keychain-access silent.\n",
    );
  }
  return EXIT_CODE.ok;
}
