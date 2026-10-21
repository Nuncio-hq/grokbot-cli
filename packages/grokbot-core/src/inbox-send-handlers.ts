import type { Agent } from "./agents.js";
import type { InboxOutputs, SentToBot } from "./command-outputs-inbox.js";
import type { HandlerRun, RunnerContext } from "./command-runner-context.js";
import { dispatchMessage } from "./command-runner-jobs.js";
import { GrokBotError, type ServerTransport } from "./contracts.js";
import { isExpired } from "./inbox-reader.js";
import { formatInboxMessage } from "./inbox-schema.js";
import type { InboxHandledAction } from "./inbox-state-store.js";
import { INBOX_LIMITS, INBOX_OUTCOMES, type InboxItem } from "./inbox-types.js";
import { findInboxItem } from "./inbox-view-handlers.js";
import { type JobOrigin, jobHandle } from "./job-queue.js";
import { compareSeq, parseEntriesResponse, type Seq } from "./transcript.js";
import { requestIdOf } from "./turn-sharing.js";

const PAGE_ROWS = 50;
/** 1,000 rows back: an item is a day or two old, and a miss only costs the reply link. */
const MAX_PAGES = 20;

/**
 * The newest row of the bot's chat that carries `run`, the run that left the item, so the
 * message goes out as a reply to it. Undefined when the run is not in the last 1,000 rows.
 */
export async function findRunEntry(
  server: ServerTransport,
  agentId: string,
  run: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (run === "") return undefined;
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
    // Entries come oldest first, so the last match is the newest.
    const hit = entries.filter((e) => requestIdOf(e) === run).at(-1);
    if (hit !== undefined) return hit.entryId;
    const oldest = entries[0]?.seq;
    if (
      oldest === undefined ||
      entries.length < PAGE_ROWS ||
      (beforeSeq !== undefined && compareSeq(oldest, beforeSeq) >= 0)
    ) {
      return undefined;
    }
    beforeSeq = oldest;
  }
  return undefined;
}

interface Prepared {
  readonly item: InboxItem;
  readonly agent: Agent;
  readonly replyToId: string | undefined;
}

/** Everything a message to the item's bot needs, and every reason to refuse before it. */
async function prepare(
  ctx: RunnerContext,
  id: string,
  signal?: AbortSignal,
): Promise<Prepared> {
  const { ref, read } = await findInboxItem(ctx, id, signal);
  if (read.state !== "ok") {
    throw new GrokBotError(
      "protocol",
      `Inbox item ${ref.id} needs a newer grokbot: npm install -g grokbotagent-cli.`,
    );
  }
  const { item } = read;
  if (item.kind === "decision") {
    throw new GrokBotError(
      "safety",
      `Inbox item ${ref.id} is a decision: only the owner answers it. Tell the owner what it asks ("${item.title}") and wait for their answer.`,
    );
  }
  if (ref.folder === "closed") {
    throw new GrokBotError(
      "safety",
      `Inbox item ${ref.id} is closed already (${item.closed?.outcome ?? "closed"}); nothing is left to answer.`,
    );
  }
  if (isExpired(item, ctx.now())) {
    throw new GrokBotError(
      "safety",
      `Inbox item ${ref.id} has expired; the bot no longer waits for an answer.`,
    );
  }
  const targetId = item.replyTo?.agentId ?? item.from.agentId;
  const agent = (await ctx.fetchAgents(signal)).find(
    (a) => a.agentId === targetId,
  );
  if (!agent) {
    throw new GrokBotError(
      "not-found",
      `Inbox item ${ref.id} goes to agent ${targetId}, which is not on this account. Check grokbot agents.`,
    );
  }
  const replyToId = await findRunEntry(
    ctx.server,
    agent.agentId,
    item.from.run,
    signal,
  );
  return { item, agent, replyToId };
}

/**
 * Sends `text` to the item's bot and records the item as handled here. The state file is
 * read before anything goes out, so a broken one stops the command instead of leaving a
 * message sent and unrecorded.
 */
async function sendAndRecord(
  ctx: RunnerContext,
  prepared: Prepared,
  text: string,
  record: { readonly action: InboxHandledAction; readonly outcome?: string },
  origin: JobOrigin,
  run: HandlerRun,
): Promise<SentToBot> {
  const { item, agent, replyToId } = prepared;
  const state = await ctx.inboxState.read();
  const job = await dispatchMessage(
    ctx,
    agent,
    text,
    run.signal,
    replyToId,
    origin,
  );
  const nowMs = ctx.now();
  try {
    await ctx.inboxState.write(
      new Map(state).set(item.id, {
        handledAt: new Date(nowMs).toISOString(),
        ...record,
        jobId: job.jobId,
      }),
      nowMs,
    );
  } catch (error) {
    throw new GrokBotError(
      "safety",
      `The message went out as job ${job.jobId}, but ${ctx.inboxState.path} could not be updated (${error instanceof Error ? error.message : String(error)}). Item ${item.id} shows in grokbot inbox again.`,
      { cause: error },
    );
  }
  return {
    id: item.id,
    jobId: job.jobId,
    agent,
    ...(replyToId !== undefined && { replyToId }),
    queued: job.state.status === "queued",
  };
}

export async function replyInbox(
  ctx: RunnerContext,
  input: {
    readonly id: string;
    readonly text?: string;
    readonly choice?: string;
  },
  run: HandlerRun,
): Promise<InboxOutputs["inbox-reply"]> {
  const text = input.text?.trim() ?? "";
  if (input.choice === undefined && text === "") {
    throw new GrokBotError(
      "ambiguous",
      "A reply needs its text, or --choice for a question.",
    );
  }
  const prepared = await prepare(ctx, input.id, run.signal);
  const { item } = prepared;
  const choice = input.choice?.trim();
  if (choice !== undefined) {
    const choices = item.ask?.choices ?? [];
    if (item.kind !== "question" || !choices.includes(choice)) {
      throw new GrokBotError(
        "safety",
        item.kind === "question"
          ? `"${choice}" is not one of the choices of ${item.id}: ${choices.join(" | ")}.`
          : `Inbox item ${item.id} is a ${item.kind}, not a question, so it has no choices to answer with.`,
      );
    }
  }
  const origin = await ctx.beginJob();
  const message = formatInboxMessage(
    { id: item.id, project: item.project },
    choice === undefined
      ? { type: "reply", text }
      : { type: "answer", choice, ...(text !== "" && { text }) },
    ctx.runtime(),
    origin.session,
    jobHandle(origin.jobId),
  );
  const action = choice === undefined ? "reply" : "answer";
  const sent = await sendAndRecord(
    ctx,
    prepared,
    message,
    { action },
    origin,
    run,
  );
  return { ...sent, action };
}

const CLOSING_OUTCOMES = INBOX_OUTCOMES.filter((o) => o !== "expired");

export async function closeInbox(
  ctx: RunnerContext,
  input: {
    readonly id: string;
    readonly outcome: string;
    readonly reason?: string;
    readonly ref?: string;
  },
  run: HandlerRun,
): Promise<InboxOutputs["inbox-done"]> {
  const outcome = CLOSING_OUTCOMES.find((o) => o === input.outcome);
  if (outcome === undefined) {
    throw new GrokBotError(
      "safety",
      `--outcome must be one of ${CLOSING_OUTCOMES.join(", ")} ("expired" is only grokbot's own).`,
    );
  }
  const reason = input.reason?.trim();
  if (reason !== undefined && [...reason].length > INBOX_LIMITS.text) {
    throw new GrokBotError(
      "safety",
      `--reason is longer than ${INBOX_LIMITS.text} characters.`,
    );
  }
  const ref = input.ref?.trim();
  if (
    ref !== undefined &&
    (!/^https:\/\/\S+$/.test(ref) || ref.length > INBOX_LIMITS.url)
  ) {
    throw new GrokBotError("safety", "--ref must be one https link.");
  }
  const prepared = await prepare(ctx, input.id, run.signal);
  const origin = await ctx.beginJob();
  const message = formatInboxMessage(
    { id: prepared.item.id, project: prepared.item.project },
    {
      type: "done",
      outcome,
      ...(reason !== undefined && reason !== "" && { reason }),
      ...(ref !== undefined && { ref }),
    },
    ctx.runtime(),
    origin.session,
    jobHandle(origin.jobId),
  );
  const sent = await sendAndRecord(
    ctx,
    prepared,
    message,
    { action: "done", outcome },
    origin,
    run,
  );
  return { ...sent, closedAs: outcome };
}
