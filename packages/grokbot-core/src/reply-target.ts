import { type Agent, pickAgentQuery, resolveAgent } from "./agents.js";
import type { RunnerContext } from "./command-runner-context.js";
import { busyRecords } from "./command-runner-jobs.js";
import { GrokBotError, type ServerTransport } from "./contracts.js";
import type { JobRecord } from "./job-store.js";
import {
  compareSeq,
  parseEntriesResponse,
  type Seq,
  type TranscriptEntry,
} from "./transcript.js";
import { readTranscriptSince } from "./transcript-stream.js";
import { findTurn } from "./turn-model.js";

/** What `reply` decides before it sends: the bot, the entry the message answers, and the part of it quoted. */
interface ReplyTarget {
  readonly agent: Agent;
  readonly replyToId: string;
  readonly replyQuote?: string;
}

interface ReplyInput {
  /** A saved job: its bot is the target, and its last bot message the default entry. */
  readonly job?: string;
  /** An entry of the bot's transcript; replaces the job's last bot message. */
  readonly to?: string;
  /** The words of that entry the reply quotes, like selecting text before Reply in the app. */
  readonly quote?: string;
  /** Names the bot when there is no job; with a job it must be that job's bot. */
  readonly agent?: string;
}

const PAGE_ROWS = 50;
/** 5,000 rows back, far past any conversation an agent replies into. */
const MAX_PAGES = 100;

const refuse = (message: string) => new GrokBotError("not-found", message);

/** The row `entryId` of the bot's main transcript, searched from the newest row back. */
async function findEntry(
  server: ServerTransport,
  agentId: string,
  entryId: string,
  signal?: AbortSignal,
): Promise<TranscriptEntry | undefined> {
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
    const found = entries.find((e) => e.entryId === entryId);
    if (found) return found;
    const oldest = entries[0]?.seq;
    if (
      oldest === undefined ||
      entries.length < PAGE_ROWS ||
      (beforeSeq !== undefined && compareSeq(oldest, beforeSeq) >= 0)
    )
      return undefined;
    beforeSeq = oldest;
  }
  return undefined;
}

/** A job's message must have gone out before there is a message to reply to. */
function assertSent(job: JobRecord): void {
  const { jobId, state } = job;
  const name = job.agentName ?? "the bot";
  if (state.status === "queued") {
    throw refuse(
      `Job ${jobId} is still queued for ${name}: its message has not gone out. Change it with grokbot edit ${jobId} "<text>" instead.`,
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

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The words an entry shows, when its row carries them: a message or a text reply, not a card, an attachment or a blob. */
function entryText(entry: TranscriptEntry): string | undefined {
  switch (entry.kind) {
    case "user-message":
    case "assistant-message":
      return entry.content;
    case "reply":
      return entry.reply.type === "text" ? entry.reply.content : undefined;
    default:
      return undefined;
  }
}

/**
 * The quote to send with a reply to `entry`: as given, once it is known to be part of the
 * entry's text (spaces and line breaks do not matter). Only an entry whose text cannot be
 * read here (not found, or a reply stored as a blob) leaves nothing to check against, so the
 * quote goes as given; a card, attachment or visual has no words to quote.
 */
function checkedQuote(
  quote: string,
  entry: TranscriptEntry | undefined,
  agent: Agent,
): string {
  if (entry === undefined || entry.kind === "blob") return quote;
  const text = entryText(entry);
  if (text === undefined || !collapse(text).includes(collapse(quote))) {
    throw refuse(
      `The quote is not in ${agent.name}'s message ${entry.entryId} (spaces and line breaks do not matter). Copy the words from that entry in grokbot tail --json, or leave out --quote.`,
    );
  }
  return quote;
}

/**
 * The entry a reply on a job answers: the newest message the bot wrote in the job's own turn
 * (a reply or a reply stored as a blob, not a card, tool call or message to another bot),
 * or the job's own message while the bot has written none, read from the transcript.
 */
async function jobEntry(
  ctx: RunnerContext,
  job: JobRecord,
  agent: Agent,
  signal?: AbortSignal,
): Promise<TranscriptEntry> {
  const page = await readTranscriptSince(
    ctx.server,
    { agentId: job.agentId, afterSeq: job.baselineUpdatedSeq },
    { signal },
  );
  const echo = page.entries.find(
    (e) => e.kind === "user-message" && e.clientNonce === job.sentMessageId,
  );
  if (!echo) {
    throw refuse(
      `Job ${job.jobId}'s message is not in ${agent.name}'s transcript (still landing, or the conversation was cleared). Pass --to <entryId> from grokbot tail --json.`,
    );
  }
  const turn = findTurn(
    page.entries,
    job.sentMessageId,
    await busyRecords(ctx.jobs, job),
  );
  const last = turn?.rows
    .filter(
      (e) =>
        e.kind === "reply" ||
        (e.kind === "blob" && e.entryKind === "send-message"),
    )
    .at(-1);
  return last ?? echo;
}

/**
 * The bot and entry a reply answers. With a job, the bot is the job's and the entry is its
 * last bot message, else the job's own message, or `to`. Without a job, `to` is required
 * and the usual agent selection (`--agent`, GROKBOT_AGENT, project route, primary Bot) names
 * the bot. Refuses an unknown job, a job whose message has not gone out, a `to` that is
 * not in the bot's transcript, an empty `quote`, and a `quote` that is not in the entry's
 * text (an entry whose text cannot be read lets it through).
 */
export async function resolveReplyTarget(
  ctx: RunnerContext,
  { job: jobId, to, quote, agent: flag }: ReplyInput,
  signal?: AbortSignal,
): Promise<ReplyTarget> {
  if (quote !== undefined && collapse(quote) === "") {
    throw refuse(
      "The quote is empty. Pass the words of the message you answer with --quote, or leave it out to answer the whole message.",
    );
  }
  let agent: Agent;
  let replyToId: string;
  let entry: TranscriptEntry | undefined;
  if (jobId !== undefined) {
    const job = await ctx.jobs.load(jobId);
    if (!job) {
      throw refuse(
        `No saved job "${jobId}" in ${ctx.jobs.dir}. Use the job id printed by send or ask.`,
      );
    }
    assertSent(job);
    agent = await jobAgent(ctx, job, flag, signal);
    if (to === undefined) {
      entry = await jobEntry(ctx, job, agent, signal);
      replyToId = entry.entryId;
    } else {
      replyToId = to;
    }
  } else if (to !== undefined) {
    agent = await ctx.target(flag, signal);
    replyToId = to;
  } else {
    throw refuse(
      'A reply needs a job and its text (grokbot reply <job> "..."), or the text with --to <entryId> from grokbot tail --json and the bot named by --agent or routing.',
    );
  }
  if (to !== undefined) {
    entry = await findEntry(ctx.server, agent.agentId, to, signal);
    if (entry === undefined) {
      throw refuse(
        `Entry ${to} is not in ${agent.name}'s transcript. Use an entryId from grokbot tail --json for that bot.`,
      );
    }
  }
  return {
    agent,
    replyToId,
    ...(quote !== undefined && {
      replyQuote: checkedQuote(quote, entry, agent),
    }),
  };
}
