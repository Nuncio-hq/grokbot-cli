import {
  isProtectedRole,
  normalizeAgentId,
  type ProtectedBots,
  type ProtectedRole,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

export const PROTECT = "protect";
export const UNPROTECT = "unprotect";

export const PROTECT_HELP = [
  "protect marks one of your bots on this computer. grokbot then refuses to fire it or",
  "  change its skills and routines unless --force-protected names its full agentId.",
  "  main  Your main bot: agents never experiment on it.",
  "  test  A test bot: agents run experiments and smoke tests there.",
  "unprotect removes the mark. Take agentIds from grokbot agents --json.",
];

/** The protected list's side effects, injectable so tests never touch ~/.grokbot. */
export interface ProtectDeps {
  readonly protectedPath: string;
  readProtected(): Promise<ProtectedBots>;
  writeProtected(bots: ProtectedBots): Promise<void>;
}

interface ProtectContext {
  readonly stdout: TextSink;
  readonly deps: ProtectDeps;
  readonly json: boolean;
  /** Reports a usage error and returns its exit code. */
  readonly usage: (error: string) => number;
}

/** Lines for `grokbot config` with no setting: each protected bot and its role. */
export function describeProtected(bots: ProtectedBots, path: string): string {
  const rows = [...bots].map(([id, role]) => `${id}  ${role}`);
  const first =
    rows.shift() ??
    "none (mark one with grokbot config protect <agentId> <main|test>)";
  const pad = " ".repeat("protected        ".length);
  return [
    `protected        ${first}`,
    ...rows.map((row) => `${pad}${row}`),
    `\nProtected bots file: ${path}`,
  ].join("\n");
}

export const protectedJson = (bots: ProtectedBots) => Object.fromEntries(bots);

/** Runs `grokbot config protect <agentId> <main|test>` or `unprotect <agentId>`. */
export async function runProtectCommand(
  setting: typeof PROTECT | typeof UNPROTECT,
  args: readonly string[],
  ctx: ProtectContext,
): Promise<number> {
  const [rawId, role, ...extra] = args;
  const wanted = setting === PROTECT ? 2 : 1;
  if (rawId === undefined || args.length !== wanted || extra.length > 0) {
    return ctx.usage(
      setting === PROTECT
        ? "protect takes <agentId> <main|test>"
        : "unprotect takes <agentId>",
    );
  }
  const id = normalizeAgentId(rawId);
  if (id === undefined) {
    return ctx.usage(
      `"${rawId}" is not a full agentId (see grokbot agents --json)`,
    );
  }
  if (setting === PROTECT && !isProtectedRole(role)) {
    return ctx.usage('the role must be "main" or "test"');
  }

  const bots = new Map(await ctx.deps.readProtected());
  const before = bots.get(id);
  const after: ProtectedRole | undefined =
    setting === PROTECT ? (role as ProtectedRole) : undefined;
  const changed = before !== after;
  if (changed) {
    if (after === undefined) bots.delete(id);
    else bots.set(id, after);
    await ctx.deps.writeProtected(bots);
  }
  if (ctx.json) {
    ctx.stdout.write(
      `${JSON.stringify({ agentId: id, role: after ?? null, changed }, null, 2)}\n`,
    );
  } else if (after === undefined) {
    ctx.stdout.write(
      changed
        ? `${id} is no longer protected.\n`
        : `${id} was not protected.\n`,
    );
  } else {
    ctx.stdout.write(
      changed
        ? `${id} is now protected as ${after}.\n`
        : `${id} is already protected as ${after}.\n`,
    );
  }
  return EXIT_CODE.ok;
}
