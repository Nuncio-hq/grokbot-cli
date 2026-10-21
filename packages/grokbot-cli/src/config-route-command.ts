import {
  normalizeAgentId,
  type ProjectRoutes,
  projectKeys,
  routeForFolder,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

export const ROUTE = "route";
export const UNROUTE = "unroute";

export const ROUTE_HELP = [
  "route sends this folder's messages to one bot: grokbot send and ask in it (or below it) go",
  "  to <agentId> when no --agent or GROKBOT_AGENT is given. Without a route, the account's",
  "  primary Bot answers. The route is keyed by the folder's git remote (origin), so every",
  "  clone of the project shares it, or by the folder's absolute path when it has no remote",
  "  or --path is given. --label <text> names the project in the tag grokbot puts on each message,",
  "  [text · <agent runtime>], so the bot knows the project and who is writing.",
  "unroute removes this folder's route (same keying). Take agentIds from grokbot agents --json.",
];

/** The routes file and working folder, injectable so tests never touch ~/.grokbot. */
export interface RouteDeps {
  readonly routesPath: string;
  /** The folder `route` and `unroute` act on. */
  readonly cwd: string;
  readRoutes(): Promise<ProjectRoutes>;
  writeRoutes(routes: ProjectRoutes): Promise<void>;
}

interface RouteContext {
  readonly stdout: TextSink;
  readonly deps: RouteDeps;
  readonly json: boolean;
  /** Reports a usage error and returns its exit code. */
  readonly usage: (error: string) => number;
}

/** Lines for `grokbot config` with no setting: each route, marking the one this folder uses. */
export async function describeRoutes(
  routes: ProjectRoutes,
  deps: RouteDeps,
): Promise<string> {
  const here = await routeForFolder(routes, deps.cwd);
  const rows = [...routes].map(
    ([match, route]) =>
      `${match}  ${route.agentId}${route.label ? `  [${route.label}]` : ""}${here?.match === match ? "  <- this folder" : ""}`,
  );
  const first =
    rows.shift() ??
    "none (route this folder with grokbot config route <agentId>)";
  const pad = " ".repeat("routes           ".length);
  return [
    `routes           ${first}`,
    ...rows.map((row) => `${pad}${row}`),
    `\nProject routes file: ${deps.routesPath}`,
  ].join("\n");
}

export async function routesJson(routes: ProjectRoutes, deps: RouteDeps) {
  const here = await routeForFolder(routes, deps.cwd);
  return {
    projectRoutes: Object.fromEntries(routes),
    projectRoutesPath: deps.routesPath,
    thisFolderRoute: here ?? null,
  };
}

interface Parsed {
  readonly words: readonly string[];
  readonly label?: string;
  readonly path: boolean;
  readonly error?: string;
}

function parseRouteArgs(args: readonly string[]): Parsed {
  const words: string[] = [];
  let label: string | undefined;
  let path = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--path") path = true;
    else if (arg === "--label" || arg.startsWith("--label=")) {
      const value =
        arg === "--label" ? args[++i] : arg.slice("--label=".length);
      if (value === undefined || value.trim() === "")
        return { words, path, error: "--label needs a non-empty text" };
      label = value.trim();
    } else if (arg.startsWith("-"))
      return { words, path, error: `unknown flag "${arg.split("=", 1)[0]}"` };
    else words.push(arg);
  }
  return { words, path, ...(label !== undefined && { label }) };
}

/** Runs `grokbot config route <agentId> [--label <text>] [--path]` or `unroute [--path]`. */
export async function runRouteCommand(
  setting: typeof ROUTE | typeof UNROUTE,
  args: readonly string[],
  ctx: RouteContext,
): Promise<number> {
  const parsed = parseRouteArgs(args);
  if (parsed.error !== undefined) return ctx.usage(parsed.error);
  const { words, label, path } = parsed;
  if (setting === UNROUTE && (words.length > 0 || label !== undefined)) {
    return ctx.usage("unroute takes no arguments besides --path");
  }
  const [rawId, ...extra] = words;
  let agentId: string | undefined;
  if (setting === ROUTE) {
    if (rawId === undefined || extra.length > 0)
      return ctx.usage("route takes <agentId> [--label <text>] [--path]");
    agentId = normalizeAgentId(rawId);
    if (agentId === undefined) {
      return ctx.usage(
        `"${rawId}" is not a full agentId (see grokbot agents --json)`,
      );
    }
  }

  const keys = await projectKeys(ctx.deps.cwd);
  const key = path ? keys.path : (keys.remote ?? keys.path);
  const routes = new Map(await ctx.deps.readRoutes());
  const before = routes.get(key);
  const after =
    agentId === undefined
      ? undefined
      : { agentId, ...(label !== undefined && { label }) };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    if (after === undefined) routes.delete(key);
    else routes.set(key, after);
    await ctx.deps.writeRoutes(routes);
  }
  if (ctx.json) {
    ctx.stdout.write(
      `${JSON.stringify({ match: key, route: after ?? null, changed }, null, 2)}\n`,
    );
  } else if (after === undefined) {
    ctx.stdout.write(
      changed ? `Removed the route for ${key}.\n` : `No route for ${key}.\n`,
    );
  } else {
    const tag = after.label ? ` as [${after.label}]` : "";
    ctx.stdout.write(
      changed
        ? `${key} now goes to ${after.agentId}${tag}.\n`
        : `${key} already goes to ${after.agentId}${tag}.\n`,
    );
  }
  return EXIT_CODE.ok;
}
