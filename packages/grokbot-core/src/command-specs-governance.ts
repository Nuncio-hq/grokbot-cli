import {
  AGENT_PARAM,
  type CommandSpec,
  JSON_PARAM,
  YES_PARAM,
} from "./command-spec.js";

const AGENTS = "ListGrokBotAgents";
const PRIMARY = "GetGrokBotUserRuntimeSettings";
const ENTRIES = "ListGrokBotTranscriptEntries";
const STATUSES = "ListGrokBotAgentStatuses";

const WORKER_NAME = {
  type: "string",
  description: "Display name for the worker (defaults to the hostname)",
} as const;

const CARD = {
  type: "string",
  description:
    "Entry id of the card to act on (needed only when more than one is open)",
} as const;

/**
 * Phase 03: resolve approval cards, inspect computers and Box MCP, open a bot's desktop,
 * and start a self-hosted worker. Two-word verbs (mcp list, worker start) are hyphenated
 * so they stay single catalog tokens and leave the shared argv parser untouched.
 */
export const GOVERNANCE_COMMANDS = {
  approvals: {
    summary: "List open approval cards for one agent or every agent",
    safety: "read-only",
    methods: [AGENTS, PRIMARY, ENTRIES, STATUSES],
    params: { agent: AGENT_PARAM, json: JSON_PARAM },
  },
  answer: {
    summary: "Answer or dismiss a bot's question widget",
    safety: "writes",
    methods: [
      AGENTS,
      PRIMARY,
      ENTRIES,
      "RespondGrokBotWidget",
      "DismissGrokBotWidget",
    ],
    params: {
      value: {
        type: "string",
        description: "The answer to send (omit with --dismiss)",
        position: 0,
      },
      agent: AGENT_PARAM,
      card: CARD,
      dismiss: {
        type: "boolean",
        description: "Close the widget without answering it",
        default: false,
      },
      json: JSON_PARAM,
    },
  },
  approve: {
    summary: "Approve an auto-review or local-tool permission card",
    safety: "sensitive",
    methods: [
      AGENTS,
      PRIMARY,
      ENTRIES,
      "ResolveGrokBotAutoReviewApproval",
      "ResolveGrokBotLocalToolPermission",
    ],
    params: {
      agent: AGENT_PARAM,
      card: CARD,
      always: {
        type: "boolean",
        description: "Allow this action from now on, not just once",
        default: false,
      },
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  deny: {
    summary: "Deny an auto-review or local-tool permission card",
    safety: "sensitive",
    methods: [
      AGENTS,
      PRIMARY,
      ENTRIES,
      "ResolveGrokBotAutoReviewApproval",
      "ResolveGrokBotLocalToolPermission",
    ],
    params: {
      agent: AGENT_PARAM,
      card: CARD,
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  computers: {
    summary: "List the computers registered to run bot requests",
    safety: "read-only",
    methods: ["ListGrokBotUserComputers"],
    params: { json: JSON_PARAM },
  },
  "mcp-list": {
    summary: "List the Box MCP servers and their tool counts",
    safety: "read-only",
    methods: [],
    gatewayMethods: ["getMcpState"],
    params: { json: JSON_PARAM },
  },
  "mcp-call": {
    summary: "Call one Box MCP tool and print its result",
    safety: "sensitive",
    methods: [],
    gatewayMethods: ["callMcpAppTool"],
    params: {
      server: {
        type: "string",
        description: "MCP server identifier (from grokbot mcp-list)",
        required: true,
        position: 0,
      },
      tool: {
        type: "string",
        description: "Tool name on that server",
        required: true,
        position: 1,
      },
      args: {
        type: "string",
        description: "Tool arguments as a JSON object string",
        default: "{}",
      },
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  vnc: {
    // EnsureSandBoxWindow takes only a window index, so the window alone picks the desktop.
    summary: "Open one live desktop window on the box (VNC)",
    safety: "writes",
    methods: ["EnsureSandBoxWindow"],
    params: {
      window: {
        type: "integer",
        description: "Desktop window on the box; it selects the bot (e.g. 3)",
        required: true,
        minimum: 1,
      },
      // Flag name keeps the hyphen; its input key is "print-url".
      "print-url": {
        type: "boolean",
        description:
          "Print the viewer URL (a credential) instead of opening it",
        default: false,
      },
      json: JSON_PARAM,
    },
  },
  "worker-plan": {
    // Read-only twin of worker-start: prints the exact command and env names, starts
    // nothing. It is a separate command because the runner checks --yes on a sensitive
    // command before any handler runs, so `worker-start --dry-run` could never skip it.
    // It reads ListGrokBotUserComputers so the owner can see the machines already
    // registered before adding this one.
    summary: "Show the exact worker command and env names without starting it",
    safety: "read-only",
    methods: ["ListGrokBotUserComputers"],
    params: { name: WORKER_NAME, json: JSON_PARAM },
  },
  "worker-start": {
    // Spawns `cursor-agent worker` as the GrokBot account and calls no GrokBotService
    // RPC itself. The sensitive tag is anchored to IssueGrokBotUserComputerCredential,
    // the RPC family that registers a machine to receive bot work, which is the effect
    // of starting a worker. The handler never calls it.
    summary: "Start a self-hosted cursor-agent worker as the GrokBot account",
    safety: "sensitive",
    methods: ["IssueGrokBotUserComputerCredential"],
    params: { name: WORKER_NAME, yes: YES_PARAM, json: JSON_PARAM },
  },
  "cloud-agents": {
    // The list is the first frame of the app's own update stream; the stream is closed
    // after it. --agent reads each agent's launch watchers: the bot that started a cloud
    // agent holds a LAUNCH watch on it (an agent's triggeredPrincipal is the account's
    // user, never the bot).
    summary: "List the account's Cursor cloud agents, newest activity first",
    safety: "read-only",
    methods: [AGENTS, "GetGrokBotCloudAgentWatchers"],
    composerMethods: ["StreamBackgroundComposerUpdates"],
    params: {
      limit: {
        type: "integer",
        description: "Number of cloud agents to list",
        default: 20,
        minimum: 1,
        alias: "n",
      },
      agent: {
        type: "string",
        description:
          "Only the cloud agents this bot launched (name, slug, or agentId); default: every cloud agent on the account",
      },
      json: JSON_PARAM,
    },
  },
  "cloud-agent": {
    summary:
      "Show one Cursor cloud agent: status, repo, pull request, and its last messages",
    safety: "read-only",
    methods: [],
    composerMethods: [
      "GetBackgroundComposerInfo",
      "GetBackgroundComposerConversation",
      "StreamBackgroundComposerUpdates",
    ],
    params: {
      bcId: {
        type: "string",
        description: "Cloud agent id, bc-… (from grokbot cloud-agents)",
        required: true,
        position: 0,
      },
      messages: {
        type: "integer",
        description: "Number of recent messages to show (0: none)",
        default: 10,
        minimum: 0,
      },
      wait: {
        type: "boolean",
        description:
          "Follow the agent until it stops running (exit 0), needs you (exit 3) or --timeout passes (exit 4)",
        default: false,
      },
      timeout: {
        type: "integer",
        description: "With --wait: seconds to follow before giving up",
        default: 600,
        minimum: 1,
      },
      json: JSON_PARAM,
    },
  },
} as const satisfies Record<string, CommandSpec>;

export type GovernanceCommandName = keyof typeof GOVERNANCE_COMMANDS;
