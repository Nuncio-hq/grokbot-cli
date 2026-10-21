import { type Agent, pickAgentQuery, resolveAgent } from "./agents.js";
import type { RunnerContext } from "./command-runner-context.js";
import { busyRecords } from "./command-runner-jobs.js";
import { GrokBotError, type ServerTransport } from "./contracts.js";
import type { JobRecord } from "./job-store.js";
import { compareSeq, parseEntriesResponse, type Seq } from "./transcript.js";
import { readTranscriptSince } from "./transcript-stream.js";
import { findTurn } from "./turn-model.js";

/** What `reply` decides before it sends: the bot, and the entry the message answers. */
interface ReplyTarget {
  readonly agent: Agent;
  readonly replyToId: string;
}

interface ReplyInput {
  /** A saved job: its bot is the target, and its last bot message the default entry. */
  readonly job?: string;
  /** An entry of the bot's transcript; replaces the job's last bot message. */
  readonly to?: string;
  /** Names the bot when there is no job; with a job it must be that job's bot. */
  readonly agent?: string;
}

const PAGE_ROWS = 50;
/** 5,000 rows back, far past any conversation an agent replies into. */
const MAX_PAGES = 100;

const refuse = (message: string) => new GrokBotError("not-found", message);

/** Whether `entryId` is a row of the bot's main transcript, searched from the newest row back. */
async function hasEntry(
  server: ServerTransport,
  agentId: string,
  entryId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let beforeSeq: Seq | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { entries } = parseEntriesResponse(
      await server.call(
        "ListGrokBotTranscriptEntries",
        {
          agentId,
          sessionId: "",
          limit: PAGE_ROWS,
          ...(beforeSeq !== undefined && { beforeSeq }),
        },
        { signal },
      ),
    );
    if (entries.some((e) => e.entryId === entryId)) return true;
    const oldest = entries[0]?.seq;
    if (
      oldest === undefined ||
      entries.length < PAGE_ROWS ||
      (beforeSeq !== undefined && compareSeq(oldest, beforeSeq) >= 0)
    )
      return false;
    beforeSeq = oldest;
  }
  return false;
}

/** A job's message must have gone out before there is a turn to take a bot message from. */
function assertSent(job: JobRecord): void {
  const { jobId, state } = job;
  const name = job.agentName ?? "the bot";
  if (state.status === "queued") {
    throw refuse(
      `Job ${jobId} is still queued for ${name}: its message has not gone out. Run grokbot wait ${jobId}, then reply.`,
    );
  }
  if (state.status === "sending") {
    throw refuse(
      `Job ${jobId} may not have reached ${name} yet. Run grokbot wait ${jobId}, then reply.`,
    );
  }
  if (state.status === "failed" && state.notSent) {
    throw refuse(
      `Job ${jobId} was never sent (${state.error}), so ${name} has no message to reply to.`,
    );
  }
}

/** The bot a job went to; `--agent`, when also given, must name that bot. */
async function jobAgent(
  ctx: RunnerContext,
  job: JobRecord,
  flag: string | undefined,
  signal?: AbortSignal,
): Promise<Agent> {
  const agents = await ctx.fetchAgents(signal);
  const agent = agents.find((a) => a.agentId === job.agentId);
  if (!agent) {
    throw refuse(
      `Job ${job.jobId} went to agent ${job.agentId}, which is not on this account. Check grokbot agents.`,
    );
  }
  const query = pickAgentQuery({ flag });
  if (
    query !== undefined &&
    resolveAgent(query, agents).agentId !== agent.agentId
  ) {
    throw refuse(
      `Job ${job.jobId} went to ${agent.name}, not ${query}. Leave out --agent to reply on that job, or drop the job to answer an entry of another bot with --to.`,
    );
  }
  return agent;
}

/**
 * The newest message the bot wrote in the job's own turn (a reply or a reply stored as a
 * blob, not a card, tool call or message to another bot), read from the transcript.
 */
async function lastBotMessage(
  ctx: RunnerContext,
  job: JobRecord,
  agent: Agent,
  signal?: AbortSignal,
): Promise<string> {
  const page = await readTranscriptSince(
    ctx.server,
    { agentId: job.agentId, afterSeq: job.baselineUpdatedSeq },
    { signal },
  );
  const turn = findTurn(
    page.entries,
    job.sentMessageId,
    await busyRecords(ctx.jobs, job),
  );
  if (!turn) {
    throw refuse(
      `Job ${job.jobId}'s message is not in ${agent.name}'s transcript (was the conversation cleared?). Pass --to <entryId> from grokbot tail --json.`,
    );
  }
  const last = turn.rows
    .filter(
      (e) =>
        e.kind === "reply" ||
        (e.kind === "blob" && e.entryKind === "send-message"),
    )
    .at(-1);
  if (!last) {
    throw refuse(
      `${agent.name} has not posted a message in job ${job.jobId} yet. Run grokbot wait ${job.jobId} first, or pass --to <entryId> from grokbot tail --json.`,
    );
  }
  return last.entryId;
}

/**
 * The bot and entry a reply answers. With a job, the bot is the job's and the entry is its
 * last bot message, or `to`. Without a job, `to` is required and the usual agent selection
 * (`--agent`, GROKBOT_AGENT, project route, primary Bot) names the bot. Refuses an unknown
 * job, a job whose message has not gone out, and a `to` that is not in the bot's transcript.
 */
export async function resolveReplyTarget(
  ctx: RunnerContext,
  { job: jobId, to, agent: flag }: ReplyInput,
  signal?: AbortSignal,
): Promise<ReplyTarget> {
  let agent: Agent;
  let replyToId: string;
  if (jobId !== undefined) {
    const job = await ctx.jobs.load(jobId);
    if (!job) {
      throw refuse(
        `No saved job "${jobId}" in ${ctx.jobs.dir}. Use the job id printed by send or ask.`,
      );
    }
    assertSent(job);
    agent = await jobAgent(ctx, job, flag, signal);
    replyToId = to ?? (await lastBotMessage(ctx, job, agent, signal));
  } else if (to !== undefined) {
    agent = await ctx.target(flag, signal);
    replyToId = to;
  } else {
    throw refuse(
      'A reply needs a job and its text (grokbot reply <job> "..."), or the text with --to <entryId> from grokbot tail --json and the bot named by --agent or routing.',
    );
  }
  if (
    to !== undefined &&
    !(await hasEntry(ctx.server, agent.agentId, to, signal))
  ) {
    throw refuse(
      `Entry ${to} is not in ${agent.name}'s transcript. Use an entryId from grokbot tail --json for that bot.`,
    );
  }
  return { agent, replyToId };
}
