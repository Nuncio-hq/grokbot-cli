import { type CommandSpec, JSON_PARAM } from "./command-spec.js";

const ROSTER = "ListGrokBotAgents";
const STAT = "StatSandBoxStoreObject";
const PRESIGN = "PresignSandBoxStoreReads";
const STORE = [STAT, PRESIGN] as const;
const ENTRIES = "ListGrokBotTranscriptEntries";
const SEND = "SendGrokBotUserMessage";

const ID = {
  type: "string",
  description: "Inbox item id, the 8 characters `grokbot inbox` prints first",
  required: true,
  position: 0,
} as const;

/**
 * The inbox: what the owner's bots left for the assistants on this computer. The bots write
 * on their cloud computer; these commands read it through the server's copy of that
 * computer and answer through the bot's chat.
 */
export const INBOX_COMMANDS = {
  inbox: {
    summary:
      "List the open items your bots left for this assistant: bugs, tasks, questions, results",
    safety: "read-only",
    methods: [ROSTER, ...STORE],
    params: {
      project: {
        type: "string",
        description:
          "Only this project (default: this folder's project route, else every project)",
      },
      all: {
        type: "boolean",
        description: "Every project, even when this folder has a project route",
        default: false,
      },
      "include-handled": {
        type: "boolean",
        description: "Also list items already replied to or closed from here",
        default: false,
      },
      json: JSON_PARAM,
    },
  },
  "inbox-show": {
    summary:
      "Show one inbox item in full, with the bot, age, local folder and machine state",
    safety: "read-only",
    methods: [ROSTER, "ListGrokBotUserComputers", ...STORE],
    params: { id: ID, json: JSON_PARAM },
  },
  "inbox-fetch": {
    summary:
      "Save an inbox item's files, or any /workspace or /home file of the bots' cloud computer, to this computer",
    safety: "read-only",
    methods: STORE,
    params: {
      id: ID,
      file: {
        type: "string",
        description: "Name of one of the item's files (default: all of them)",
      },
      path: {
        type: "string",
        description:
          "A file or folder of the cloud computer, under /workspace or /home, instead of the item's files",
      },
      out: {
        type: "string",
        description:
          "Folder to save into (CLI only; default ~/.grokbot/inbox-files/<id>/)",
      },
      json: JSON_PARAM,
    },
  },
  "inbox-reply": {
    summary:
      "Reply to the bot that left an inbox item, or answer its question with --choice; returns a job id",
    safety: "writes",
    methods: [ROSTER, ENTRIES, SEND, ...STORE],
    params: {
      id: ID,
      text: {
        type: "string",
        description: "Your reply (optional when --choice says it all)",
        position: 1,
      },
      choice: {
        type: "string",
        description: "One of the question's choices, for a question item",
      },
      json: JSON_PARAM,
    },
  },
  "inbox-done": {
    summary:
      "Tell the bot that left an inbox item how you finished it; returns a job id",
    safety: "writes",
    methods: [ROSTER, ENTRIES, SEND, ...STORE],
    params: {
      id: ID,
      outcome: {
        type: "string",
        description:
          "fixed, answered, done, wont-fix, duplicate, superseded or handed-off",
        required: true,
      },
      reason: {
        type: "string",
        description: "Why, in a sentence (up to 300 characters)",
      },
      ref: {
        type: "string",
        description: "https link to the fix, pull request or answer",
      },
      json: JSON_PARAM,
    },
  },
  "inbox-wait": {
    summary:
      "Wait until a bot leaves an open item for this session or one of its jobs, then print it; run it in the background when your runtime can",
    safety: "read-only",
    methods: [ROSTER, ...STORE],
    params: {
      job: {
        type: "string-list",
        description:
          "A job to watch: its id from send or ask, or the 8 characters after Job: in a message header (default: every job this session sent)",
      },
      timeout: {
        type: "string",
        description:
          "How long to wait: seconds, or a duration such as 90s, 9m or 1h; 0 checks once",
        default: "9m",
      },
      json: JSON_PARAM,
    },
  },
  "inbox-check": {
    summary:
      "For a hook that runs before the agent stops: print undelivered items for this session or its jobs and exit 2, else exit 0 silently",
    safety: "read-only",
    methods: [ROSTER, ...STORE],
    params: { json: JSON_PARAM },
  },
} as const satisfies Record<string, CommandSpec>;

export type InboxCommandName = keyof typeof INBOX_COMMANDS;
