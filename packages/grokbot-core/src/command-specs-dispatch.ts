import { AGENT_PARAM, type CommandSpec, JSON_PARAM } from "./command-spec.js";

const TEXT = {
  type: "string",
  description: "Message to send to the agent",
  required: true,
  position: 0,
} as const;
const TIMEOUT = {
  type: "integer",
  description: "Seconds to wait before giving up",
  default: 600,
  minimum: 1,
} as const;
const RESOLVE = "ListGrokBotAgents";
const SEND = "SendGrokBotUserMessage";
const STATUSES = "ListGrokBotAgentStatuses";
const ENTRIES = "ListGrokBotTranscriptEntries";
const WATCH = ["WatchGrokBotTranscripts", ENTRIES, STATUSES] as const;

/** Phase 01: list agents, dispatch messages, and follow jobs to the Done Rule. */
export const DISPATCH_COMMANDS = {
  agents: {
    summary: "List GrokBot agents on the account",
    safety: "read-only",
    methods: [RESOLVE],
    params: { json: JSON_PARAM },
  },
  team: {
    summary: "List agents with live running/idle/awaiting status",
    safety: "read-only",
    methods: [RESOLVE, STATUSES],
    params: { json: JSON_PARAM },
  },
  ask: {
    summary: "Send a prompt and wait until the Done Rule settles",
    safety: "writes",
    methods: [RESOLVE, SEND, ...WATCH],
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
    methods: [RESOLVE, ENTRIES, SEND],
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
    methods: [RESOLVE, ENTRIES],
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
    methods: [RESOLVE, "InterruptGrokBotAgentRun"],
    params: { agent: AGENT_PARAM, json: JSON_PARAM },
  },
} as const satisfies Record<string, CommandSpec>;

export type DispatchCommandName = keyof typeof DISPATCH_COMMANDS;
