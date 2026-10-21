import { type CommandSpec, JSON_PARAM, YES_PARAM } from "./command-spec.js";
import { AGENT, FORCE_PROTECTED } from "./command-specs-workforce-library.js";

const ROUTINE = {
  type: "string",
  description: "Routine name or automationId",
  required: true,
  position: 1,
} as const;
const ROSTER = "ListGrokBotAgents";
const ROUTINES = "ListGrokBotAgentAutomations";
/** Sends and statuses for the chat path: a bot saves its own routines. */
const CHAT = [
  "SendGrokBotUserMessage",
  "ListGrokBotAgentStatuses",
  "ListGrokBotTranscriptEntries",
  "WatchGrokBotTranscripts",
] as const;
const CHAT_TIMEOUT = {
  type: "integer",
  description: "Seconds to wait for the bot to save it in chat",
  default: 300,
  minimum: 1,
} as const;

/** The trigger flags of routines-create and routines-update; name at most one kind. */
const TRIGGER_FLAGS = {
  cron: {
    type: "string",
    description:
      'Fire on a schedule, e.g. "0 9 * * 1" or "CRON_TZ=Australia/Adelaide 0 9 * * 1"',
  },
  webhook: {
    type: "boolean",
    description:
      "Fire on a POST to the routine's webhook (key: routines-webhook-key)",
    default: false,
  },
  email: { type: "string", description: "Fire on mail to this bot inbox" },
  from: {
    type: "string-list",
    description: "With email: only mail from these senders",
  },
  "require-auth-pass": {
    type: "boolean",
    description: "With email: only mail that passes sender authentication",
    default: false,
  },
  github: {
    type: "string",
    description: "Fire on GitHub events in this owner/repo",
  },
  events: {
    type: "string-list",
    description:
      "With github: events such as ci-failed, ci-passed, pr-opened, pr-merged, review-requested",
  },
  "ci-branch": {
    type: "string",
    description: "With github: only CI runs on this branch",
  },
  pr: {
    type: "integer",
    description: "With github: only this pull request",
    minimum: 1,
  },
  trigger: {
    type: "string",
    description:
      "Any trigger as JSON (Slack, Microsoft Teams, Linear, Sentry, PagerDuty, Origin, or a group of two or more)",
  },
  "trigger-file": {
    type: "string",
    description: "File holding the trigger JSON (CLI only)",
  },
} as const;

const routineToggle = (summary: string) =>
  ({
    summary,
    safety: "writes",
    methods: [ROSTER, ROUTINES, "SetGrokBotAgentAutomationEnabled"],
    params: {
      agent: AGENT,
      routine: ROUTINE,
      "force-protected": FORCE_PROTECTED,
      json: JSON_PARAM,
    },
  }) as const satisfies CommandSpec;

/** Each bot's routines: list, switch, create, edit, and fire by webhook. */
export const ROUTINE_COMMANDS = {
  "routines-list": {
    summary: "List a bot's routines with trigger and next run",
    safety: "read-only",
    methods: [ROSTER, ROUTINES],
    params: { agent: AGENT, json: JSON_PARAM },
  },
  "routines-enable": routineToggle("Turn a bot's routine on"),
  "routines-disable": routineToggle("Turn a bot's routine off"),
  "routines-delete": {
    summary: "Delete a bot's routine, and its webhook key in the Keychain",
    safety: "destructive",
    methods: [ROSTER, ROUTINES, "DeleteGrokBotAgentAutomation"],
    params: {
      agent: AGENT,
      routine: ROUTINE,
      "force-protected": FORCE_PROTECTED,
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  "routines-create": {
    summary:
      "Create a routine for a bot: on a schedule, webhook, email, GitHub event, or any trigger as JSON",
    safety: "writes",
    methods: [ROSTER, ROUTINES, ...CHAT],
    params: {
      agent: AGENT,
      name: { type: "string", description: "Routine name", required: true },
      prompt: {
        type: "string",
        description: "What the bot does on each run",
        required: true,
      },
      ...TRIGGER_FLAGS,
      paused: {
        type: "boolean",
        description: "Create it switched off",
        default: false,
      },
      "force-protected": FORCE_PROTECTED,
      timeout: CHAT_TIMEOUT,
      json: JSON_PARAM,
    },
  },
  "routines-update": {
    summary: "Change a bot's routine: its name, prompt, or trigger",
    safety: "writes",
    methods: [ROSTER, ROUTINES, ...CHAT],
    params: {
      agent: AGENT,
      routine: ROUTINE,
      name: { type: "string", description: "New routine name" },
      prompt: { type: "string", description: "New prompt" },
      ...TRIGGER_FLAGS,
      "force-protected": FORCE_PROTECTED,
      timeout: CHAT_TIMEOUT,
      json: JSON_PARAM,
    },
  },
  "routines-webhook-key": {
    summary:
      "Mint a webhook routine's key into the macOS Keychain; it is never printed",
    safety: "sensitive",
    methods: [ROSTER, ROUTINES],
    dashboardMethods: ["CreateAutomationWebhookApiKey"],
    params: {
      agent: AGENT,
      routine: ROUTINE,
      "force-protected": FORCE_PROTECTED,
      replace: {
        type: "boolean",
        description:
          "Mint an additional key even if one is stored; earlier keys stay valid until the routine is deleted",
        default: false,
      },
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  "routines-fire": {
    summary:
      "Fire a webhook routine with the key in the Keychain and an optional JSON body",
    safety: "writes",
    methods: [ROSTER, ROUTINES],
    firesWebhook: true,
    params: {
      agent: AGENT,
      routine: ROUTINE,
      payload: { type: "string", description: "JSON body to send" },
      "payload-file": {
        type: "string",
        description: "File holding the JSON body (CLI only)",
      },
      json: JSON_PARAM,
    },
  },
} as const satisfies Record<string, CommandSpec>;
