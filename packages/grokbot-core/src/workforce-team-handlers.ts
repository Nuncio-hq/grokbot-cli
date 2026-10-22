import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { assertMayTouch } from "./workforce-protected-agents.js";
import {
  parseDismissReason,
  pickSuggestions,
  REASON_WIRE,
} from "./workforce-suggestions.js";
import { parseAgentAnalytics } from "./workforce-team-analytics.js";
import { explainingRefusal } from "./workforce-team-refusal.js";
import {
  DECISION_WIRE,
  parseResolvedItem,
  parseReviewDecision,
  parseReviewFilter,
  parseReviewItems,
  wireStatuses,
} from "./workforce-team-review.js";

type Names =
  | "review"
  | "review-resolve"
  | "analytics"
  | "suggestions"
  | "suggestions-dismiss";

const LIST = "ListGrokBotTeamReviewItems";
const RESOLVE = "ResolveGrokBotTeamReviewItem";
const ANALYTICS = "GetGrokBotAgentAnalytics";
const DISMISS = "DismissGrokBotAgentSuggestions";

const NO_QUEUE = "A personal bot has no review queue.";
const NO_ANALYTICS = "Analytics seem to exist only for Team Bots.";

/** Team Bot upkeep: the review queue, usage analytics, and starter prompts. */
export function teamHandlers(ctx: RunnerContext): CommandHandlers<Names> {
  const { server } = ctx;

  return {
    review: async (input, { signal }) => {
      const status = parseReviewFilter(input.status);
      const agent = await ctx.target(input.agent, signal);
      const reply = await explainingRefusal(agent, LIST, NO_QUEUE, () =>
        server.call(
          LIST,
          {
            agentId: agent.agentId,
            statuses: wireStatuses(status),
            limit: input.limit,
          },
          { signal },
        ),
      );
      return {
        agent,
        status,
        limit: input.limit,
        items: parseReviewItems(reply, LIST),
      };
    },

    "review-resolve": async (input, { signal, confirmed }) => {
      const decision = parseReviewDecision(input.decision);
      const itemId = input.item.trim();
      const agent = await ctx.target(input.agent, signal);
      assertMayTouch(
        agent,
        input["force-protected"],
        "review-resolve",
        await ctx.protectedBots(),
      );
      const reply = await explainingRefusal(agent, RESOLVE, "", () =>
        server.call(
          RESOLVE,
          {
            agentId: agent.agentId,
            itemId,
            decision: DECISION_WIRE[decision],
          },
          { signal, confirmed },
        ),
      );
      return {
        agent,
        decision,
        itemId,
        item: parseResolvedItem(reply, RESOLVE, itemId),
      };
    },

    analytics: async (input, { signal }) => {
      const agent = await ctx.target(input.agent, signal);
      const reply = await explainingRefusal(
        agent,
        ANALYTICS,
        NO_ANALYTICS,
        () => server.call(ANALYTICS, { agentId: agent.agentId }, { signal }),
      );
      return { agent, ...parseAgentAnalytics(reply, ANALYTICS) };
    },

    suggestions: async (input, { signal }) => {
      const agent = await ctx.target(input.agent, signal);
      return { agent, suggestions: agent.suggestions ?? [] };
    },

    "suggestions-dismiss": async (input, { signal, confirmed }) => {
      const reason = parseDismissReason(input.reason);
      const agent = await ctx.target(input.agent, signal);
      assertMayTouch(
        agent,
        input["force-protected"],
        "suggestions-dismiss",
        await ctx.protectedBots(),
      );
      const dismissed = pickSuggestions(agent, input.suggestion);
      await server.call(
        DISMISS,
        {
          agentId: agent.agentId,
          suggestionIds: dismissed.map((s) => s.id),
          reason: REASON_WIRE[reason],
        },
        { signal, confirmed },
      );
      return { agent, reason, dismissed };
    },
  };
}
