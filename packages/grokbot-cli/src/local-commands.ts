import {
  AUTH_HELP,
  type AuthCommandName,
  type AuthDeps,
  isAuthCommand,
  runAuthCommand,
} from "./auth-command.js";
import { defaultAuthDeps } from "./auth-command-default-deps.js";
import {
  CONFIG_HELP,
  type ConfigDeps,
  defaultConfigDeps,
  runConfigCommand,
} from "./config-command.js";
import { errorMessage } from "./error-message.js";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";
import {
  defaultStatsDeps,
  runStatsCommand,
  STATS_HELP,
  type StatsDeps,
} from "./stats-command.js";

/**
 * Local commands outside the RPC catalog: login / logout / whoami, config and stats. They
 * never build the runner (stats --bots makes its own read-only calls) and MCP never offers them.
 */
type LocalName = AuthCommandName | "config" | "stats";

export interface LocalContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  readonly signal?: AbortSignal;
  readonly auth?: AuthDeps;
  readonly config?: ConfigDeps;
  readonly stats?: StatsDeps;
}

/** Words and flags that may come before the command name, as elsewhere in the CLI. */
const LEADING = new Set(["help", "--help", "-h", "--json"]);
const isLocal = (name: string | undefined): name is LocalName =>
  name === "config" || name === "stats" || isAuthCommand(name);

/**
 * Finds a local command after leading flags: `whoami`, `--json whoami`, `help login`,
 * `--help config`. Help words become `--help` for the command.
 */
export function localInvocation(
  argv: readonly string[],
): { readonly name: LocalName; readonly args: readonly string[] } | undefined {
  const at = argv.findIndex((arg) => !LEADING.has(arg));
  const name = argv[at];
  if (at < 0 || !isLocal(name)) return undefined;
  const leading = argv
    .slice(0, at)
    .map((arg) => (arg === "help" || arg === "-h" ? "--help" : arg));
  return { name, args: [...leading, ...argv.slice(at + 1)] };
}

const INTERRUPTED = Symbol("interrupted");

/** Runs one local command with the same help, Ctrl-C and error handling as catalog commands. */
export async function runLocal(
  name: LocalName,
  args: readonly string[],
  ctx: LocalContext,
): Promise<number> {
  const { stdout, stderr } = ctx;
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(
      name === "config"
        ? CONFIG_HELP
        : name === "stats"
          ? STATS_HELP
          : AUTH_HELP[name],
    );
    return EXIT_CODE.ok;
  }
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (ctx.signal?.aborted) forward();
  else ctx.signal?.addEventListener("abort", forward, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(INTERRUPTED);
    if (controller.signal.aborted) stop();
    else controller.signal.addEventListener("abort", stop, { once: true });
  });
  try {
    const run =
      name === "config"
        ? runConfigCommand(args, {
            stdout,
            stderr,
            deps: ctx.config ?? defaultConfigDeps(),
          })
        : name === "stats"
          ? runStatsCommand(args, {
              stdout,
              stderr,
              signal: controller.signal,
              deps: ctx.stats ?? defaultStatsDeps(ctx.env),
            })
          : runAuthCommand(name, args, {
              stdout,
              stderr,
              env: ctx.env,
              isTTY: ctx.isTTY,
              signal: controller.signal,
              deps: ctx.auth ?? defaultAuthDeps(),
            });
    return await Promise.race([run, aborted]);
  } catch (error) {
    if (error === INTERRUPTED || controller.signal.aborted) {
      stderr.write("grokbot: interrupted\n");
      return EXIT_CODE.interrupted;
    }
    stderr.write(errorMessage(error));
    return EXIT_CODE.failure;
  } finally {
    ctx.signal?.removeEventListener("abort", forward);
  }
}
