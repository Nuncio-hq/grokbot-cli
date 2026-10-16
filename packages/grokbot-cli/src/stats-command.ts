import {
  type BotMessageCount,
  cliConfigStore,
  createServerTransport,
  createTokenSource,
  DEFAULT_USAGE_DIR,
  jobStore,
  localHour,
  ownerMessageCounts,
  summarizeUsage,
  type UsageEvent,
  type UsageSummary,
  usageEnabled,
  usageLog,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * `grokbot stats`: reads the local usage log (never sent anywhere). With --bots it also
 * counts, per bot, the owner messages sent through grokbot versus typed in the app; that
 * read-only call keeps counts only. CLI-only, like config.
 */
export const STATS_SUMMARY =
  "Show how grokbot was used, from its local usage log (--bots adds message counts)";

export const STATS_HELP = [
  STATS_SUMMARY,
  "",
  "Usage: grokbot stats [--since <7d|30d|90d|all>] [--bots] [--json]",
  "",
  "  --since  How far back to look (default 30d). The log keeps about 90 days.",
  "  --bots   Also count, per bot, your messages sent through grokbot and the rest:",
  "           typed in the Grok Bot app (phone or desktop) or sent by a tool that keeps",
  "           no grokbot job here. Reads GrokBot; counts only, no text.",
  "",
  "The log is ~/.grokbot/usage. It holds the command, who ran it (you, Claude Code,",
  "a script...), how it ended and how long it took; never messages, replies, bot",
  "names or ids. Turn it off with grokbot config usage off.",
  "",
].join("\n");

const DAY_MS = 86_400_000;

/** Side effects of `grokbot stats`, injectable so tests never touch disk or network. */
export interface StatsDeps {
  readonly dir: string;
  readEvents(sinceHour: string | undefined): Promise<UsageEvent[]>;
  logOn(): Promise<boolean>;
  botCounts(sinceMs: number, signal?: AbortSignal): Promise<BotMessageCount[]>;
  now(): number;
}

export function defaultStatsDeps(
  env: Readonly<Record<string, string | undefined>>,
): StatsDeps {
  const log = usageLog();
  return {
    dir: DEFAULT_USAGE_DIR,
    readEvents: (since) => log.read(since),
    logOn: () =>
      usageEnabled(env, async () => (await cliConfigStore().read()).usage),
    botCounts: (sinceMs, signal) => {
      const tokens = createTokenSource();
      const server = createServerTransport({
        getToken: () => tokens.getToken(),
      });
      return ownerMessageCounts({ server, jobs: jobStore(), sinceMs, signal });
    },
    now: () => Date.now(),
  };
}

interface StatsContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly signal?: AbortSignal;
  readonly deps: StatsDeps;
}

const usage = (stderr: TextSink, error: string) => {
  stderr.write(`grokbot: stats: ${error}\n`);
  stderr.write(`${STATS_HELP.split("\n")[2]}\n`);
  return EXIT_CODE.usage;
};

/** "a 3 · b 1", largest first. */
function counts(record: Readonly<Record<string, number>>): string {
  const parts = Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function humanText(
  summary: UsageSummary,
  period: string,
  bots: readonly BotMessageCount[] | undefined,
  logOn: boolean,
  dir: string,
): string {
  const width = Math.max(8, ...summary.commands.map((c) => c.command.length));
  const lines = [
    `grokbot usage, ${period}: ${summary.total} ${summary.total === 1 ? "run" : "runs"}`,
    "",
    `Who:       ${counts(summary.byClient)}`,
    `Where:     ${counts(summary.bySurface)}`,
    `Outcomes:  ${counts(summary.outcomes)}`,
    `Errors:    ${counts(summary.errors)}`,
    `Time:      ${counts(summary.durations)}`,
    `Bot kinds: ${counts(summary.botKinds)}`,
    "",
    "Commands:",
    ...(summary.commands.length === 0
      ? ["  none yet"]
      : summary.commands.map(
          (c) =>
            `  ${c.command.padEnd(width)}  ${String(c.count).padStart(4)}${c.errors > 0 ? `  (${c.errors} failed)` : ""}`,
        )),
  ];
  if (bots) {
    const name = Math.max(8, ...bots.map((b) => b.bot.length));
    lines.push(
      "",
      `Your messages per bot, ${period} (other = Grok Bot app, or a tool with no grokbot job):`,
      ...bots.map(
        (b) =>
          `  ${b.bot.padEnd(name)}  grokbot ${String(b.viaGrokbot).padStart(3)}   other ${String(b.other).padStart(3)}`,
      ),
    );
  }
  lines.push(
    "",
    `Usage log: ${logOn ? "on" : "off"}, local only, in ${dir}`,
    "",
  );
  return lines.join("\n");
}

/** Runs `grokbot stats ...` and returns its exit code. Errors propagate to `main`. */
export async function runStatsCommand(
  args: readonly string[],
  ctx: StatsContext,
): Promise<number> {
  let since = "30d";
  let bots = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--bots") bots = true;
    else if (arg === "--since" || arg.startsWith("--since=")) {
      const value = arg === "--since" ? args[++i] : arg.slice(8);
      if (value === undefined)
        return usage(ctx.stderr, "--since needs a value");
      since = value;
    } else return usage(ctx.stderr, `unknown argument "${arg}"`);
  }
  const days = /^(\d{1,3})d$/.exec(since)?.[1];
  if (since !== "all" && (days === undefined || Number(days) === 0))
    return usage(ctx.stderr, '--since must be like 7d, 30d or 90d, or "all"');

  const nowMs = ctx.deps.now();
  const sinceMs = days === undefined ? 0 : nowMs - Number(days) * DAY_MS;
  const sinceHour = days === undefined ? undefined : localHour(sinceMs);
  const period = days === undefined ? "all saved" : `last ${days} days`;
  const summary = summarizeUsage(await ctx.deps.readEvents(sinceHour));
  const botRows = bots
    ? await ctx.deps.botCounts(sinceMs, ctx.signal)
    : undefined;
  const logOn = await ctx.deps.logOn();
  ctx.stdout.write(
    json
      ? `${JSON.stringify({ since: sinceHour ?? null, logOn, ...summary, ...(botRows && { bots: botRows }) }, null, 2)}\n`
      : humanText(summary, period, botRows, logOn, ctx.deps.dir),
  );
  return EXIT_CODE.ok;
}
