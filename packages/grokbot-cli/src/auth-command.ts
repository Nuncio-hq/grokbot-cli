import { homedir } from "node:os";
import {
  type BrowserLoginOptions,
  type CallerSession,
  CLIENT_NAMES,
  type ClientLabel,
  type DetectedClient,
  describeProxy,
  detectCallerSession,
  GROKBOT_BACKEND,
  hasSession,
  isNewerVersion,
  type LoginResult,
  resolveProxy,
  SESSION_ACTIVE_MS,
  type SignInInfo,
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
  whoami: "Show which sign-in and which agent grokbot detects, never the token",
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
  /** The installed Grok Bot desktop app's version (undefined when absent) and the version grokbot's catalog was checked against. */
  appVersions(): Promise<AppVersions>;
  openUrl(url: string): Promise<void>;
  readStdin(): Promise<string>;
  renderQr(url: string): string;
}

export interface AppVersions {
  readonly installed: string | undefined;
  readonly catalog: string;
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
    "Also reports the caller grokbot detected (an agent runtime, a terminal or a script)",
    "and which signal decided it: GROKBOT_CLIENT, AI_AGENT, the MCP client, or a runtime's",
    "own marker variable. grokbot starts every message it sends with a header naming the",
    "project, that runtime and its session, so an agent never names itself. If the caller",
    "is wrong, set GROKBOT_CLIENT to the runtime's name (for example codex or hermes).",
    "Only the variable's name is shown.",
    "",
    "The Session line gives the session's address (<runtime>:<id>) and what found it:",
    "GROKBOT_SESSION, the runtime's own thread variable, or the one session file of this",
    "folder's runtime that changed in the last two minutes. With none, or two or more",
    "recent sessions, it says so; the owner then sets GROKBOT_SESSION to the id the",
    "runtime shows (<id> or <runtime>:<id>).",
    "",
    "The Grok Bot app line gives the installed desktop app's version and the version",
    "grokbot's tool and method catalog was checked against. When the installed app is",
    "newer, whoami warns that it may have features grokbot has no command for yet. A",
    "missing app is not an error; --json carries app: {installed, catalog, newer}.",
    "",
    "Exits 1 when neither grokbot nor the Grok Bot app is signed in.",
    "",
  ].join("\n"),
};

interface AuthContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly caller: DetectedClient;
  readonly isTTY: boolean;
  readonly signal: AbortSignal;
  readonly deps: AuthDeps;
  /** The folder whose session `whoami` looks up. Default: process.cwd(). */
  readonly cwd?: string;
  /** The home folder agent runtimes keep sessions under. Default: os.homedir(). */
  readonly home?: string;
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
  // Whether the proxy settings apply to the backend: the one line a proxied user needs to see.
  const active = resolveProxy(GROKBOT_BACKEND, ctx.env);
  const proxy = active ? describeProxy(active) : null;
  const info = await ctx.deps.describe();
  const { label, signal } = ctx.caller;
  const name = CLIENT_NAMES[label];
  const caller = { label, name, signal };
  const who = name === label ? name : `${name} (${label})`;
  const session = await detectCallerSession({
    env: ctx.env,
    cwd: ctx.cwd ?? process.cwd(),
    home: ctx.home ?? homedir(),
    caller: label,
  });
  const { installed, catalog } = await ctx.deps.appVersions();
  const app = {
    installed: installed ?? null,
    catalog,
    newer: installed !== undefined && isNewerVersion(installed, catalog),
  };
  ctx.stdout.write(
    flags.json
      ? `${JSON.stringify({ ...info, caller, session, app, proxy }, null, 2)}\n`
      : `${describeSignIn(info)}\nCaller: ${who}, detected from ${signal}.\n${describeSession(session, label)}\n${describeApp(app)}\n${proxy ? `Proxy: ${proxy.url} (from ${proxy.source})\n` : ""}`,
  );
  if (info.source === "none") {
    ctx.stderr.write("Not signed in. Run grokbot login.\n");
    return EXIT_CODE.failure;
  }
  return EXIT_CODE.ok;
}

/** The `Grok Bot app:` line of `whoami`, with a plain warning when the installed app is newer than the catalog. */
function describeApp(app: {
  readonly installed: string | null;
  readonly catalog: string;
  readonly newer: boolean;
}): string {
  const line = `Grok Bot app: ${app.installed ?? "not found"}, grokbot's catalog was checked against ${app.catalog}.`;
  return app.newer
    ? `${line}\nWarning: the installed app is newer than grokbot's catalog, so it may have features grokbot has no command for yet.`
    : line;
}

const SET_SESSION =
  "Set GROKBOT_SESSION to the id your runtime shows for this session.";

/** The `Session:` line of `whoami`: the address and what found it, or why there is none. */
function describeSession(session: CallerSession, label: ClientLabel): string {
  if (hasSession(session)) {
    return `Session: ${session.address}, detected from ${session.signal}.`;
  }
  if (session.signal === "ambiguous") {
    return `Session: unknown. ${session.candidates ?? 0} sessions of this folder were active in the last ${SESSION_ACTIVE_MS / 60_000} minutes, so grokbot cannot tell which is yours. ${SET_SESSION}`;
  }
  return label === "human"
    ? "Session: none. A person at a terminal has no agent session."
    : `Session: none. grokbot found no session of this folder active in the last ${SESSION_ACTIVE_MS / 60_000} minutes. ${SET_SESSION}`;
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
