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
    "Job id (from send or ask) whose bot you answer, and whose last bot message is the one answered; omit it with --to",
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
    "Entry id of the bot message to answer, from tail --json (default: the job's last bot message). Without a job, --agent or routing names the bot",
} as const;
/** `setup-bots` sends to the primary Bot, so the host's default agent and the folder's route do not apply. */
const SETUP_AGENT = {
  type: "string",
  description:
    "Agent name, slug, or agentId to set up instead of the primary Bot (GROKBOT_AGENT and project routes never apply)",
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
      agent: AGENT_PARAM,
      json: JSON_PARAM,
    },
  },
  send: {
    summary:
      "Dispatch a message, or queue it while the bot is busy, and return a resumable job id",
    safety: "writes",
    methods: [ROSTER, PRIMARY, ENTRIES, SEND],
    params: { text: TEXT, agent: AGENT_PARAM, json: JSON_PARAM },
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
      timeout: TIMEOUT,
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
      agent: SETUP_AGENT,
      json: JSON_PARAM,
    },
  },
} as const satisfies Record<string, CommandSpec>;

export type DispatchCommandName = keyof typeof DISPATCH_COMMANDS;
