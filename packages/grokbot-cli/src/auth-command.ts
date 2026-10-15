import type {
  BrowserLoginOptions,
  LoginResult,
  SignInInfo,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * Account commands. They are CLI-only on purpose: not catalog commands (they call no
 * GrokBotService RPC), so grokbot-mcp never offers them, and a remote MCP client can
 * never drive a browser sign-in or touch the Keychain.
 */
export const AUTH_COMMANDS = {
  login: "Sign grokbot in through the browser (own Keychain sign-in)",
  logout: "Remove grokbot's own sign-in (the app's login is untouched)",
  whoami: "Show which sign-in grokbot uses, never the token",
} as const;
export type AuthCommandName = keyof typeof AUTH_COMMANDS;

export const isAuthCommand = (
  name: string | undefined,
): name is AuthCommandName =>
  name !== undefined && Object.hasOwn(AUTH_COMMANDS, name);

/** Side effects of the account commands, injectable so tests never open a browser or the Keychain. */
export interface AuthDeps {
  loginWithBrowser(options: BrowserLoginOptions): Promise<LoginResult>;
  loginWithApiKey(apiKey: string): Promise<LoginResult>;
  /** True when a saved sign-in was removed. */
  clear(): Promise<boolean>;
  describe(): Promise<SignInInfo>;
  openUrl(url: string): Promise<void>;
  readStdin(): Promise<string>;
  renderQr(url: string): string;
}

const LOGIN_FLAGS = ["--no-browser", "--api-key", "--json"] as const;
const API_KEY_TAKES_NO_VALUE =
  "--api-key takes no value; set GROKBOT_API_KEY or pipe the key on stdin so it stays out of shell history";

export const AUTH_HELP: { readonly [N in AuthCommandName]: string } = {
  login: [
    AUTH_COMMANDS.login,
    "",
    "Usage: grokbot login [--no-browser] [--api-key] [--json]",
    "",
    "Opens cursor.com in your browser and prints the same link as a QR code, so you",
    "can finish on any device. Email, password, 2FA or one-time codes are entered on",
    "that page, never in this terminal. grokbot waits, then keeps the sign-in in the",
    'macOS Keychain (item "grokbot-cli") and refreshes it automatically.',
    "",
    "Flags:",
    "  --no-browser  Only print the link and QR (remote or headless machine)",
    "  --api-key     Sign in with a Cursor API key from GROKBOT_API_KEY or stdin",
    "  --json        Return machine-readable JSON (default: false)",
    "",
  ].join("\n"),
  logout: [
    AUTH_COMMANDS.logout,
    "",
    "Usage: grokbot logout [--json]",
    "",
    "Afterwards grokbot falls back to the Grok Bot desktop app's login.",
    "",
  ].join("\n"),
  whoami: [
    AUTH_COMMANDS.whoami,
    "",
    "Usage: grokbot whoami [--json]",
    "",
    "Exits 1 when neither grokbot nor the Grok Bot app is signed in.",
    "",
  ].join("\n"),
};

interface AuthContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  readonly signal: AbortSignal;
  readonly deps: AuthDeps;
}

interface Flags {
  readonly json: boolean;
  readonly noBrowser: boolean;
  readonly apiKey: boolean;
}

/** Parses the account flags; returns an error line on anything unexpected. */
function parseFlags(
  name: AuthCommandName,
  args: readonly string[],
): Flags | { readonly error: string } {
  const allowed: readonly string[] =
    name === "login" ? LOGIN_FLAGS : ["--json"];
  const flags = { json: false, noBrowser: false, apiKey: false };
  for (const [i, arg] of args.entries()) {
    if (!allowed.includes(arg)) {
      // A value after or attached to --api-key is the key itself: never echo it.
      if (args[i - 1] === "--api-key" || arg.startsWith("--api-key=")) {
        return { error: API_KEY_TAKES_NO_VALUE };
      }
      // Only the flag name is ever echoed; anything after "=" may be a secret.
      const flag = arg.split("=", 1)[0] ?? "";
      return {
        error: `unknown flag "${flag.startsWith("-") ? flag : "(value)"}"`,
      };
    }
    if (arg === "--json") flags.json = true;
    if (arg === "--no-browser") flags.noBrowser = true;
    if (arg === "--api-key") flags.apiKey = true;
  }
  return flags;
}

/** Runs one account command and returns its exit code. Errors propagate to `main`. */
export async function runAuthCommand(
  name: AuthCommandName,
  args: readonly string[],
  ctx: AuthContext,
): Promise<number> {
  const parsed = parseFlags(name, args);
  if ("error" in parsed) {
    ctx.stderr.write(`grokbot: ${name}: ${parsed.error}\n`);
    ctx.stderr.write(`${AUTH_HELP[name].split("\n")[2]}\n`);
    return EXIT_CODE.usage;
  }
  switch (name) {
    case "login":
      return parsed.apiKey
        ? loginApiKey(parsed, ctx)
        : loginBrowser(parsed, ctx);
    case "logout":
      return logout(parsed, ctx);
    case "whoami":
      return whoami(parsed, ctx);
  }
}

async function loginBrowser(flags: Flags, ctx: AuthContext): Promise<number> {
  const result = await ctx.deps.loginWithBrowser({
    openBrowser: !flags.noBrowser,
    signal: ctx.signal,
    openUrl: (url) => ctx.deps.openUrl(url),
    showUrl: (url) => {
      const lead = flags.noBrowser
        ? "Open this link"
        : "Opening your browser. If it does not open, use this link";
      ctx.stderr.write(`${lead} to sign in:\n\n  ${url}\n\n`);
      if (ctx.isTTY && !flags.json) ctx.stderr.write(ctx.deps.renderQr(url));
      ctx.stderr.write(
        "Finish signing in on that page; grokbot is waiting (Ctrl-C to cancel)...\n",
      );
    },
  });
  return signedIn(result, flags, ctx);
}

async function loginApiKey(flags: Flags, ctx: AuthContext): Promise<number> {
  const key =
    ctx.env.GROKBOT_API_KEY?.trim() || (await ctx.deps.readStdin()).trim();
  if (key === "") {
    ctx.stderr.write(
      "grokbot: login: --api-key needs a key: set GROKBOT_API_KEY or pipe the key on stdin\n",
    );
    return EXIT_CODE.usage;
  }
  return signedIn(await ctx.deps.loginWithApiKey(key), flags, ctx);
}

function signedIn(result: LoginResult, flags: Flags, ctx: AuthContext): number {
  ctx.stdout.write(
    flags.json
      ? `${JSON.stringify({ signedIn: true, method: result.method }, null, 2)}\n`
      : "Signed in. grokbot now uses its own sign-in (saved in the macOS Keychain).\n",
  );
  return EXIT_CODE.ok;
}

async function logout(flags: Flags, ctx: AuthContext): Promise<number> {
  const removed = await ctx.deps.clear();
  const text = removed
    ? "Signed out of grokbot. The Grok Bot app's own login is unchanged.\n"
    : "grokbot had no saved sign-in.\n";
  ctx.stdout.write(
    flags.json ? `${JSON.stringify({ removed }, null, 2)}\n` : text,
  );
  return EXIT_CODE.ok;
}

async function whoami(flags: Flags, ctx: AuthContext): Promise<number> {
  const info = await ctx.deps.describe();
  ctx.stdout.write(
    flags.json
      ? `${JSON.stringify(info, null, 2)}\n`
      : `${describeSignIn(info)}\n`,
  );
  if (info.source === "none") {
    ctx.stderr.write("Not signed in. Run grokbot login.\n");
    return EXIT_CODE.failure;
  }
  return EXIT_CODE.ok;
}

function describeSignIn(info: SignInInfo): string {
  switch (info.source) {
    case "cli": {
      const where = info.keychainAccess
        ? `macOS Keychain, ${info.keychainAccess} access`
        : "macOS Keychain";
      return info.expiresAt === undefined
        ? `Using grokbot's own sign-in (${where}).`
        : `Using grokbot's own sign-in (${where}), valid until ${new Date(info.expiresAt).toISOString()}.`;
    }
    case "app":
      return "Using the Grok Bot desktop app's login.";
    case "none":
      return "Not signed in.";
  }
}
