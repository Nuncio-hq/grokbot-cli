import { AGENT_PARAM, type CommandSpec, JSON_PARAM } from "./command-spec.js";

const TEXT = {
  type: "string",
  description: "Message to send to the agent",
  required: true,
  position: 0,
} as const;
const REPLY_JOB = {
  type: "string",
  description:
    "Job id (from send or ask) whose bot you answer: its last bot message is replied to, or the job's own message while the bot has written none; omit it with --to",
  position: 0,
} as const;
const REPLY_TEXT = {
  type: "string",
  description: "Your reply, sent to the bot",
  required: true,
  position: 1,
} as const;
const REPLY_TO = {
  type: "string",
  description:
    "Entry id to reply to, from tail --json (default: the job's last bot message, else the job's own message). Without a job, --agent or routing names the bot",
} as const;
const REPLY_QUOTE = {
  type: "string",
  description:
    "Words of that message to quote with the reply, like selecting text before Reply in the app. They must appear in the message (spaces and line breaks may differ), else the reply is refused",
} as const;
/** The sender, not grokbot, decides whether a message waits for a busy bot. */
const NOW = {
  type: "boolean",
  description:
    "Send at once even while the bot is busy, so it reads the message during its current work and may answer both in one reply (exit 5); without it the message waits in the queue",
  default: false,
} as const;
/** `setup-bots` and `update-bots` send to the primary Bot, so the host's default agent and the folder's route do not apply. */
const BOTS_SIDE_AGENT = {
  type: "string",
  description:
    "Agent name, slug, or agentId to ask instead of the primary Bot (GROKBOT_AGENT and project routes never apply)",
} as const;
const TIMEOUT = {
  type: "integer",
  description: "Seconds to wait before giving up",
  default: 600,
  minimum: 1,
} as const;
const ROSTER = "ListGrokBotAgents";
/** Where the primary Bot comes from when nothing else selects an agent. */
const PRIMARY = "GetGrokBotUserRuntimeSettings";
const SEND = "SendGrokBotUserMessage";
const STATUSES = "ListGrokBotAgentStatuses";
const ENTRIES = "ListGrokBotTranscriptEntries";
const WATCH = ["WatchGrokBotTranscripts", ENTRIES, STATUSES] as const;

/** Phase 01: list agents, dispatch messages, and follow jobs to the Done Rule. */
export const DISPATCH_COMMANDS = {
  agents: {
    summary: "List GrokBot agents on the account",
    safety: "read-only",
    methods: [ROSTER],
    params: { json: JSON_PARAM },
  },
  team: {
    summary: "List agents with live running/idle/awaiting status",
    safety: "read-only",
    methods: [ROSTER, STATUSES],
    params: { json: JSON_PARAM },
  },
  ask: {
    summary: "Send a prompt and wait until the Done Rule settles",
    safety: "writes",
    methods: [ROSTER, PRIMARY, SEND, ...WATCH],
    params: {
      text: TEXT,
      timeout: TIMEOUT,
      now: NOW,
      agent: AGENT_PARAM,
      json: JSON_PARAM,
    },
  },
  send: {
    summary:
      "Dispatch a message, or queue it while the bot is busy, and return a resumable job id",
    safety: "writes",
    methods: [ROSTER, PRIMARY, ENTRIES, SEND],
    params: { text: TEXT, now: NOW, agent: AGENT_PARAM, json: JSON_PARAM },
  },
  wait: {
    summary: "Wait for a dispatched job id to finish",
    safety: "read-only",
    methods: WATCH,
    params: {
      job: {
        type: "string",
        description: "Job id returned by send",
        required: true,
        position: 0,
      },
      timeout: TIMEOUT,
      json: JSON_PARAM,
    },
  },
  tail: {
    summary: "Read recent decoded transcript entries",
    safety: "read-only",
    methods: [ROSTER, PRIMARY, ENTRIES],
    params: {
      limit: {
        type: "integer",
        description: "Number of recent entries to read",
        default: 15,
        minimum: 1,
        alias: "n",
      },
      agent: AGENT_PARAM,
      json: JSON_PARAM,
    },
  },
  interrupt: {
    summary: "Interrupt the active run on an agent",
    safety: "writes",
    methods: [ROSTER, PRIMARY, "InterruptGrokBotAgentRun"],
    params: { agent: AGENT_PARAM, json: JSON_PARAM },
  },
  reply: {
    summary:
      "Reply to one of a bot's messages, like Reply in the app, and wait until the Done Rule settles",
    safety: "writes",
    methods: [ROSTER, PRIMARY, SEND, ...WATCH],
    params: {
      job: REPLY_JOB,
      text: REPLY_TEXT,
      to: REPLY_TO,
      quote: REPLY_QUOTE,
      timeout: TIMEOUT,
      now: NOW,
      agent: AGENT_PARAM,
      json: JSON_PARAM,
    },
  },
  edit: {
    summary:
      "Change the text of a message still queued for a busy bot, then send it if the bot is free",
    safety: "writes",
    methods: [ENTRIES, STATUSES, SEND],
    params: {
      job: {
        type: "string",
        description: "Job id of the queued message (from send, ask or reply)",
        required: true,
        position: 0,
      },
      text: {
        type: "string",
        description: "The new message; it replaces the queued text in full",
        required: true,
        position: 1,
      },
      json: JSON_PARAM,
    },
  },
  search: {
    summary: "Search a bot's conversation for words, newest matches first",
    safety: "read-only",
    methods: [ROSTER, PRIMARY],
    gatewayMethods: ["searchConversation"],
    params: {
      query: {
        type: "string",
        description: "Words to look for in the conversation",
        required: true,
        position: 0,
      },
      limit: {
        type: "integer",
        description: "Most matches to return",
        default: 20,
        minimum: 1,
        alias: "n",
      },
      before: {
        type: "integer",
        description:
          "Only matches older than this seq; use the lowest seq of the previous page to read the next one",
        minimum: 0,
      },
      agent: AGENT_PARAM,
      json: JSON_PARAM,
    },
  },
  "setup-bots": {
    summary:
      "Set up the bots' side: send the bot setup prompt to the primary Bot and wait until the Done Rule settles",
    safety: "writes",
    methods: [ROSTER, PRIMARY, SEND, ...WATCH],
    params: {
      timeout: TIMEOUT,
      agent: BOTS_SIDE_AGENT,
      json: JSON_PARAM,
    },
  },
  "update-bots": {
    summary:
      "Update the bots' side: ask the primary Bot to install this grokbot version on the cloud computer and save the grokbot-inbox skill again, and wait until the Done Rule settles",
    safety: "writes",
    methods: [ROSTER, PRIMARY, SEND, ...WATCH],
    params: {
      timeout: TIMEOUT,
      agent: BOTS_SIDE_AGENT,
      json: JSON_PARAM,
    },
  },
} as const satisfies Record<string, CommandSpec>;

export type DispatchCommandName = keyof typeof DISPATCH_COMMANDS;
