import { IDLE_STATUS, parseAgentStatusesResponse } from "./agent-status.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { dispatchMessage, followJob } from "./command-runner-jobs.js";
import type { DispatchCommandName } from "./command-specs-dispatch.js";
import { GrokBotError } from "./contracts.js";
import { asJsonObject, parseEntriesResponse } from "./transcript.js";

export function dispatchHandlers(
  ctx: RunnerContext,
): CommandHandlers<DispatchCommandName> {
  const { server, target } = ctx;
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
      const job = await dispatchMessage(ctx, agent, input.text, signal);
      const { jobId, sentMessageId } = job;
      const queued = job.state.status === "queued";
      return { jobId, agent, sentMessageId, queued };
    },

    ask: async (input, run) => {
      const agent = await target(input.agent, run.signal);
      const job = await dispatchMessage(ctx, agent, input.text, run.signal);
      const { jobId, agentId } = job;
      run.onEvent?.({ type: "dispatched", jobId, agentId });
      const outcome = await followJob(ctx, job, input.timeout, run);
      return { jobId, agent, outcome };
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
