import { setTimeout as delay } from "node:timers/promises";
import { resolveAgent } from "./agents.js";
import type { CommandInput } from "./command-catalog.js";
import type { GovernanceOutputs } from "./command-outputs-governance.js";
import type { RunnerContext } from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import { followCloudAgent } from "./governance-cloud-agent-follow.js";
import {
  CLOUD_AGENT_ID,
  type CloudAgentInfo,
  type CloudAgentMessage,
  type CloudAgentSnapshot,
  isLaunchedBy,
  parseCloudAgentInfo,
  parseConversation,
  parseSnapshotFrame,
} from "./governance-cloud-agents.js";
import { mapBounded } from "./map-bounded.js";

/** Waits `ms`, or rejects when `signal` aborts. A test passes a fake clock's. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  delay(ms, undefined, { signal }).then(() => undefined);

/** The list stream sends its snapshot first; a stream silent this long is broken. */
const SNAPSHOT_TIMEOUT_MS = 30_000;
/** Launch watches read at once when `--agent` filters the list. */
const PARALLEL_WATCH_READS = 6;
const HTTP_STATUS = /failed with HTTP (\d{3})/;

const httpStatus = (error: unknown): string | undefined =>
  error instanceof GrokBotError && error.code === "http"
    ? HTTP_STATUS.exec(error.message)?.[1]
    : undefined;

/**
 * Reads the first frame of the list stream, which is the whole snapshot, then closes the
 * stream: the live updates after it are not wanted.
 */
async function readSnapshot(
  ctx: RunnerContext,
  limit: number,
  signal?: AbortSignal,
): Promise<CloudAgentSnapshot> {
  const stop = new AbortController();
  try {
    const frames = ctx.composer.stream(
      "StreamBackgroundComposerUpdates",
      { snapshotN: limit },
      {
        signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
      },
    );
    for await (const frame of frames) {
      const snapshot = parseSnapshotFrame(frame);
      if (snapshot) return snapshot;
    }
  } finally {
    stop.abort();
  }
  signal?.throwIfAborted();
  throw new GrokBotError(
    "protocol",
    "StreamBackgroundComposerUpdates ended without a snapshot.",
  );
}

export async function listCloudAgents(
  ctx: RunnerContext,
  input: CommandInput<"cloud-agents">,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["cloud-agents"]> {
  // Only the flag: this is a filter, so GROKBOT_AGENT and project routes never narrow it.
  const query = input.agent?.trim() || undefined;
  // Resolved first, so a mistyped bot fails before the list is read.
  const bot =
    query === undefined
      ? undefined
      : resolveAgent(query, await ctx.fetchAgents(signal));
  const { agents, hasMore } = await readSnapshot(ctx, input.limit, signal);
  if (!bot) return { cloudAgents: agents, hasMore, launchedBy: null };
  // The bot that launched a cloud agent holds a launch watch on it; the agent's own
  // triggeredPrincipal names the account's user, never the bot.
  const launched = await mapBounded(agents, PARALLEL_WATCH_READS, async (a) =>
    isLaunchedBy(
      await ctx.server.call(
        "GetGrokBotCloudAgentWatchers",
        { bcId: a.bcId },
        { signal },
      ),
      bot.agentId,
    ),
  );
  return {
    cloudAgents: agents.filter((_, i) => launched[i]),
    hasMore,
    launchedBy: { agentId: bot.agentId, name: bot.name },
  };
}

async function readInfo(
  ctx: RunnerContext,
  bcId: string,
  signal?: AbortSignal,
): Promise<CloudAgentInfo> {
  try {
    return parseCloudAgentInfo(
      await ctx.composer.call(
        "GetBackgroundComposerInfo",
        { bcId },
        { signal },
      ),
      bcId,
    );
  } catch (error) {
    if (httpStatus(error) !== "404") throw error;
    throw new GrokBotError(
      "not-found",
      `No cloud agent ${bcId} on this account. grokbot cloud-agents lists them.`,
    );
  }
}

/**
 * The conversation as the app reads it: turns only first, and the whole thing when the
 * server refuses that (invalid argument, HTTP 400, or unimplemented, HTTP 501).
 */
async function readConversation(
  ctx: RunnerContext,
  bcId: string,
  signal?: AbortSignal,
): Promise<readonly CloudAgentMessage[]> {
  try {
    return parseConversation(
      await ctx.composer.call(
        "GetBackgroundComposerConversation",
        { bcId, exchangeOnly: true },
        { signal },
      ),
    );
  } catch (error) {
    const status = httpStatus(error);
    if (status !== "400" && status !== "501") throw error;
    return parseConversation(
      await ctx.composer.call(
        "GetBackgroundComposerConversation",
        { bcId },
        { signal },
      ),
    );
  }
}

export async function showCloudAgent(
  ctx: RunnerContext,
  sleep: Sleep,
  input: CommandInput<"cloud-agent">,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["cloud-agent"]> {
  const bcId = input.bcId.trim();
  if (!CLOUD_AGENT_ID.test(bcId)) {
    throw new GrokBotError(
      "not-found",
      `"${bcId}" is not a cloud agent id. They look like bc-… (grokbot cloud-agents lists them).`,
    );
  }
  const settled = input.wait
    ? await followCloudAgent({
        ctx,
        sleep,
        bcId,
        timeoutS: input.timeout,
        signal,
        readInfo: (s) => readInfo(ctx, bcId, s),
      })
    : { info: await readInfo(ctx, bcId, signal), outcome: undefined };
  const all =
    input.messages === 0
      ? undefined
      : await readConversation(ctx, bcId, signal);
  return {
    cloudAgent: settled.info,
    messages: all?.slice(-input.messages) ?? [],
    messageCount: all?.length ?? null,
    ...(settled.outcome && { outcome: settled.outcome }),
  };
}
