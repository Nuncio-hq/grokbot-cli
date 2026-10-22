import { IDLE_STATUS, parseAgentStatusesResponse } from "./agent-status.js";
import type { Agent } from "./agents.js";
import { BOT_SETUP_PROMPT, botUpdatePrompt } from "./bot-setup-prompt.js";
import type {
  CommandHandlers,
  HandlerRun,
  RunnerContext,
} from "./command-runner-context.js";
import { dispatchMessage, followJob } from "./command-runner-jobs.js";
import type { DispatchCommandName } from "./command-specs-dispatch.js";
import { GrokBotError } from "./contracts.js";
import { parseConversationSearch } from "./conversation-search.js";
import { advanceQueue, editQueued } from "./job-queue.js";
import { nextStep, nextStepUnless, setupNextStep } from "./next-step.js";
import { resolveReplyTarget } from "./reply-target.js";
import { asJsonObject, parseEntriesResponse } from "./transcript.js";
import { GROKBOT_VERSION } from "./version.js";

export function dispatchHandlers(
  ctx: RunnerContext,
): CommandHandlers<DispatchCommandName> {
  const { server, target, primaryTarget } = ctx;

  /** Sends `text` to `agent` as a new job and follows it to the Done Rule: the one send path of `ask` and `setup-bots`. */
  const sendAndFollow = async (
    agent: Agent,
    text: string,
    timeout: number,
    run: HandlerRun,
    now = false,
  ) => {
    const origin = await ctx.beginJob();
    const tagged = await ctx.tagged(text, origin);
    const job = await dispatchMessage(ctx, agent, tagged, {
      signal: run.signal,
      origin,
      now,
    });
    const { jobId, agentId } = job;
    run.onEvent?.({ type: "dispatched", jobId, agentId });
    return { jobId, outcome: await followJob(ctx, job, timeout, run) };
  };

  /**
   * Notes that the bots were just asked, and answered, to run this grokbot, which ends the
   * update notice. Best effort: the update already happened, and the record is only a hint.
   */
  const botsUpdated = () =>
    ctx.botsVersion
      .write({ version: GROKBOT_VERSION, updatedAtMs: ctx.now() })
      .catch(() => undefined);

  return {
    agents: async (_input, { signal }) => ({
      agents: await ctx.fetchAgents(signal),
    }),

    team: async (_input, { signal }) => {
      const agents = await ctx.fetchAgents(signal);
      if (agents.length === 0) return { members: [] };
      const statuses = parseAgentStatusesResponse(
        await server.call(
          "ListGrokBotAgentStatuses",
          { agentIds: agents.map((a) => a.agentId) },
          { signal },
        ),
      );
      return {
        members: agents.map((agent) => ({
          agent,
          status: statuses.get(agent.agentId) ?? IDLE_STATUS,
        })),
      };
    },

    send: async (input, { signal }) => {
      const agent = await target(input.agent, signal);
      const origin = await ctx.beginJob();
      const text = await ctx.tagged(input.text, origin);
      const job = await dispatchMessage(ctx, agent, text, {
        signal,
        origin,
        now: input.now,
      });
      const { jobId, sentMessageId } = job;
      const queued = job.state.status === "queued";
      return { jobId, agent, sentMessageId, queued, next: nextStep(jobId) };
    },

    ask: async (input, run) => {
      const agent = await target(input.agent, run.signal);
      const { jobId, outcome } = await sendAndFollow(
        agent,
        input.text,
        input.timeout,
        run,
        input.now,
      );
      return { jobId, agent, outcome, ...nextStepUnless(jobId, outcome) };
    },

    "setup-bots": async (input, run) => {
      const agent = await primaryTarget(input.agent, run.signal);
      const { jobId, outcome } = await sendAndFollow(
        agent,
        BOT_SETUP_PROMPT,
        input.timeout,
        run,
      );
      if (outcome.status === "done") await botsUpdated();
      return { jobId, agent, outcome, next: setupNextStep(jobId, outcome) };
    },

    "update-bots": async (input, run) => {
      const agent = await primaryTarget(input.agent, run.signal);
      const { jobId, outcome } = await sendAndFollow(
        agent,
        botUpdatePrompt(GROKBOT_VERSION),
        input.timeout,
        run,
      );
      if (outcome.status === "done") await botsUpdated();
      return {
        jobId,
        agent,
        outcome,
        version: GROKBOT_VERSION,
        ...nextStepUnless(jobId, outcome),
      };
    },

    reply: async (input, run) => {
      const { agent, replyToId, replyQuote } = await resolveReplyTarget(
        ctx,
        input,
        run.signal,
      );
      const origin = await ctx.beginJob();
      const text = await ctx.tagged(input.text, origin);
      const job = await dispatchMessage(ctx, agent, text, {
        signal: run.signal,
        reply: {
          replyToId,
          ...(replyQuote !== undefined && { replyQuote }),
        },
        origin,
        now: input.now,
      });
      const { jobId, agentId } = job;
      run.onEvent?.({ type: "dispatched", jobId, agentId });
      const outcome = await followJob(ctx, job, input.timeout, run);
      return {
        jobId,
        agent,
        replyToId,
        outcome,
        ...nextStepUnless(jobId, outcome),
      };
    },

    edit: async (input, { signal }) => {
      const job = await ctx.jobs.load(input.job);
      if (!job) {
        throw new GrokBotError(
          "not-found",
          `No saved job "${input.job}" in ${ctx.jobs.dir}. Use the job id printed by send, ask or reply.`,
        );
      }
      const { jobId, agentId, agentName, session } = job;
      const text = await ctx.tagged(input.text, {
        jobId,
        ...(session !== undefined && { session }),
      });
      await editQueued(ctx, job, text, signal);
      await advanceQueue(ctx, agentId, jobId, signal);
      const queued = (await ctx.jobs.load(jobId))?.state.status === "queued";
      return {
        jobId,
        agentId,
        ...(agentName !== undefined && { agentName }),
        queued,
        next: nextStep(jobId),
      };
    },

    wait: async (input, run) => {
      const job = await ctx.jobs.load(input.job);
      if (!job) {
        throw new GrokBotError(
          "not-found",
          `No saved job "${input.job}" in ${ctx.jobs.dir}. Use the job id printed by send or ask.`,
        );
      }
      const outcome = await followJob(ctx, job, input.timeout, run);
      const { jobId, agentId, agentName } = job;
      return {
        jobId,
        agentId,
        ...(agentName !== undefined && { agentName }),
        outcome,
        ...nextStepUnless(jobId, outcome),
      };
    },

    tail: async (input, { signal }) => {
      const agent = await target(input.agent, signal);
      const page = parseEntriesResponse(
        await server.call(
          "ListGrokBotTranscriptEntries",
          { agentId: agent.agentId, sessionId: "", limit: input.limit },
          { signal },
        ),
      );
      return { agent, entries: page.entries };
    },

    search: async (input, { signal }) => {
      const agent = await target(input.agent, signal);
      const raw = await ctx.gateway.call(
        "searchConversation",
        {
          agentId: agent.agentId,
          query: input.query,
          limit: input.limit,
          ...(input.before !== undefined && { beforeSeq: input.before }),
        },
        { signal },
      );
      return {
        agent,
        query: input.query,
        ...parseConversationSearch(raw, input.limit),
      };
    },

    interrupt: async (input, { signal }) => {
      const agent = await target(input.agent, signal);
      const raw = await server.call(
        "InterruptGrokBotAgentRun",
        { agentId: agent.agentId, reason: "user_interrupt" },
        { signal },
      );
      return { agent, hadActiveRun: asJsonObject(raw)?.hadActiveRun === true };
    },
  };
}
