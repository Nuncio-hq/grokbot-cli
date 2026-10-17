import { type CommandSpec, JSON_PARAM, YES_PARAM } from "./command-spec.js";
import {
  AGENT,
  FORCE_PROTECTED,
  LIBRARY_COMMANDS,
} from "./command-specs-workforce-library.js";
import { ROUTINE_COMMANDS } from "./command-specs-workforce-routines.js";

const TITLE = {
  type: "string",
  description: "Job title shown under the bot's name",
} as const;
const DESCRIPTION = {
  type: "string",
  description: "What the bot does; the opening of its brief",
} as const;
const INSTRUCTIONS = {
  type: "string",
  description: "The bot's instructions, as text",
} as const;
const INSTRUCTIONS_FILE = {
  type: "string",
  description:
    "Text file whose contents become the bot's instructions (CLI only)",
} as const;
const MEMBER = {
  type: "string-list",
  description: "Room member: bot name or agentId",
  required: true,
} as const;
const ROSTER = "ListGrokBotAgents";

/** Phase 02: hire, update, and fire agents; rooms; then skills and routines. */
export const WORKFORCE_COMMANDS = {
  hire: {
    summary: "Create a bot with a role and its own /workspace/staff folder",
    safety: "writes",
    methods: [ROSTER, "CreateGrokBotTemporalAgent"],
    gatewayMethods: ["updateAgent"],
    params: {
      name: {
        type: "string",
        description: "Name of the new bot",
        required: true,
        position: 0,
      },
      title: { ...TITLE, required: true },
      description: { ...DESCRIPTION, required: true },
      instructions: INSTRUCTIONS,
      "instructions-file": INSTRUCTIONS_FILE,
      json: JSON_PARAM,
    },
  },
  update: {
    summary: "Change a bot's title, description, or instructions",
    safety: "writes",
    methods: [ROSTER],
    gatewayMethods: ["listAgents", "updateAgent"],
    params: {
      agent: AGENT,
      title: TITLE,
      description: DESCRIPTION,
      instructions: INSTRUCTIONS,
      "instructions-file": INSTRUCTIONS_FILE,
      json: JSON_PARAM,
    },
  },
  fire: {
    summary: "Delete a bot or room",
    safety: "destructive",
    methods: [ROSTER, "DeleteGrokBotAgent"],
    params: {
      agent: AGENT,
      "force-protected": FORCE_PROTECTED,
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  "room-create": {
    summary: "Create a room where several bots answer one message",
    safety: "writes",
    methods: [ROSTER, "CreateGrokBotRoom"],
    params: {
      name: {
        type: "string",
        description: "Name of the new room",
        required: true,
        position: 0,
      },
      member: MEMBER,
      description: { type: "string", description: "What the room is for" },
      json: JSON_PARAM,
    },
  },
  "room-members": {
    summary: "Set the bots in a room",
    safety: "writes",
    methods: [ROSTER, "SetGrokBotRoomMembers"],
    params: {
      room: { ...AGENT, description: "Room name or agentId" },
      member: MEMBER,
      json: JSON_PARAM,
    },
  },
  ...LIBRARY_COMMANDS,
  ...ROUTINE_COMMANDS,
} as const satisfies Record<string, CommandSpec>;

export type WorkforceCommandName = keyof typeof WORKFORCE_COMMANDS;
