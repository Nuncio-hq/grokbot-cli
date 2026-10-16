import {
  type CliConfig,
  cliConfigStore,
  credentialStore,
  isKeychainAccess,
  isUsageSetting,
  type KeychainAccess,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * `grokbot config`: grokbot's own local settings. CLI-only like login (no RPC, never
 * offered over MCP). Two settings: who may read the saved sign-in without asking, and
 * whether grokbot keeps its local usage log.
 */
export const CONFIG_SUMMARY =
  "Show or change grokbot's local settings (keychain-access, usage)";

export const CONFIG_HELP = [
  CONFIG_SUMMARY,
  "",
  "Usage: grokbot config [keychain-access [silent|prompt] | usage [on|off]] [--json]",
  "",
  "keychain-access decides who may read grokbot login's sign-in from the macOS Keychain:",
  "  silent  Any program running as you, without a dialog (default). Needed for",
  "          grokbot-mcp and background agents.",
  "  prompt  macOS asks before each grokbot run reads it (one dialog per run).",
  "          Safer, but grokbot-mcp and background agents stall until you click.",
  "",
  "Changing it re-creates the saved sign-in with the new access; you stay signed in.",
  "",
  "usage decides whether grokbot keeps its usage log on this computer (default on).",
  "  It records which command ran, from where (you, Claude Code, a script...), how it",
  "  ended and how long it took; never messages, replies, bot names or ids. Nothing",
  "  is sent anywhere. Read it with grokbot stats. GROKBOT_USAGE=off turns it off for",
  "  one run.",
  "",
  "Settings live in ~/.grokbot/grokbot-cli.json, which never holds a token.",
  "",
].join("\n");

const SETTING = "keychain-access";
const USAGE = "usage";

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
  if (setting !== undefined && setting !== SETTING && setting !== USAGE) {
    return usage(
      ctx.stderr,
      `unknown setting "${setting}" (known: ${SETTING}, ${USAGE})`,
    );
  }
  if (setting === SETTING && value !== undefined && !isKeychainAccess(value)) {
    return usage(ctx.stderr, `${SETTING} must be "silent" or "prompt"`);
  }
  if (setting === USAGE && value !== undefined && !isUsageSetting(value)) {
    return usage(ctx.stderr, `${USAGE} must be "on" or "off"`);
  }

  const current = await ctx.deps.read();
  const { keychainAccess } = current;
  if (value === undefined) {
    const saved = await ctx.deps.itemAccess();
    if (json) {
      ctx.stdout.write(
        `${JSON.stringify({ keychainAccess, usage: current.usage, savedSignIn: saved ?? null, path: ctx.deps.path }, null, 2)}\n`,
      );
    } else if (setting) {
      ctx.stdout.write(
        `${setting === USAGE ? current.usage : keychainAccess}\n`,
      );
    } else {
      const item = saved ? `(saved sign-in: ${saved})` : "(no saved sign-in)";
      ctx.stdout.write(
        `${SETTING}  ${keychainAccess}  ${item}\n${USAGE}            ${current.usage}  (local only; see grokbot stats)\n\nSettings file: ${ctx.deps.path}\n`,
      );
    }
    return EXIT_CODE.ok;
  }

  if (setting === USAGE && isUsageSetting(value)) {
    const changed = value !== current.usage;
    if (changed) await ctx.deps.write({ ...current, usage: value });
    ctx.stdout.write(
      json
        ? `${JSON.stringify({ usage: value, changed }, null, 2)}\n`
        : changed
          ? `${USAGE} is now ${value}.${value === "off" ? " Nothing new is recorded; the saved log stays until you delete ~/.grokbot/usage." : ""}\n`
          : `${USAGE} is already ${value}.\n`,
    );
    return EXIT_CODE.ok;
  }
  if (!isKeychainAccess(value)) {
    return usage(ctx.stderr, `${SETTING} must be "silent" or "prompt"`);
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
  await ctx.deps.write({ ...current, keychainAccess: value });
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
