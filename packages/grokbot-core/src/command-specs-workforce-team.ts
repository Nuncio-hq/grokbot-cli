import {
  AGENT_PARAM,
  type CommandSpec,
  JSON_PARAM,
  YES_PARAM,
} from "./command-spec.js";
import { FORCE_PROTECTED } from "./command-specs-workforce-library.js";

const ROSTER = "ListGrokBotAgents";
const PRIMARY = "GetGrokBotUserRuntimeSettings";

/** Team Bot upkeep (0.75.0): the review queue, usage analytics, and starter prompts. */
export const TEAM_COMMANDS = {
  review: {
    summary:
      "List the changes proposed to a Team Bot's shared memory and skills, which wait for its owner or a manager to approve or reject",
    safety: "read-only",
    methods: [ROSTER, PRIMARY, "ListGrokBotTeamReviewItems"],
    params: {
      agent: AGENT_PARAM,
      status: {
        type: "string",
        description: "pending, approved, rejected or all",
        default: "pending",
      },
      limit: {
        type: "integer",
        description: "Most items to list",
        default: 20,
        minimum: 1,
        alias: "n",
      },
      json: JSON_PARAM,
    },
  },
  "review-resolve": {
    summary:
      "Approve or reject one change proposed to a Team Bot; approving applies it to the shared memory or skills of everyone on the team",
    safety: "sensitive",
    methods: [ROSTER, PRIMARY, "ResolveGrokBotTeamReviewItem"],
    params: {
      item: {
        type: "string",
        description: "Review item id, as grokbot review prints it",
        required: true,
        position: 0,
      },
      decision: {
        type: "string",
        description: "approve or reject",
        required: true,
      },
      agent: AGENT_PARAM,
      "force-protected": FORCE_PROTECTED,
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  analytics: {
    summary:
      "Show a Team Bot's usage: weekly active users, minutes saved, per-day numbers and top users",
    safety: "read-only",
    methods: [ROSTER, PRIMARY, "GetGrokBotAgentAnalytics"],
    params: { agent: AGENT_PARAM, json: JSON_PARAM },
  },
  suggestions: {
    summary: "List the starter prompts the app offers for a bot",
    safety: "read-only",
    methods: [ROSTER, PRIMARY],
    params: { agent: AGENT_PARAM, json: JSON_PARAM },
  },
  "suggestions-dismiss": {
    summary:
      "Close a bot's starter prompts so the app stops offering them (ids from grokbot suggestions)",
    safety: "writes",
    methods: [ROSTER, PRIMARY, "DismissGrokBotAgentSuggestions"],
    params: {
      suggestion: {
        type: "string-list",
        description: "Suggestion id, as grokbot suggestions lists it",
        required: true,
      },
      agent: AGENT_PARAM,
      reason: {
        type: "string",
        description: "hidden (closed without using it) or acted (used it)",
        default: "hidden",
      },
      "force-protected": FORCE_PROTECTED,
      json: JSON_PARAM,
    },
  },
} as const satisfies Record<string, CommandSpec>;
