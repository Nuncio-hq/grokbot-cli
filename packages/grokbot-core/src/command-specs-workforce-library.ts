import { type CommandSpec, JSON_PARAM, YES_PARAM } from "./command-spec.js";

export const AGENT = {
  type: "string",
  description: "Bot name, slug, or agentId",
  required: true,
  position: 0,
} as const;
/** The override is the bot's own id, so acting on a protected bot always names it. */
export const FORCE_PROTECTED = {
  type: "string",
  description:
    "Act on a bot you protected with grokbot config protect: its full agentId (CLI only)",
} as const;
const INCLUDE_MANAGED = {
  type: "boolean",
  description:
    "Also match the plugin and managed skills the box ships with (CLI only)",
  default: false,
} as const;
const SKILL = {
  type: "string",
  description: "Skill name or workflow id",
  required: true,
  position: 1,
} as const;
const ROSTER = "ListGrokBotAgents";
const SKILLS = "getAgentWorkflows";

/** Phase 02: the Box-wide skill library. */
export const LIBRARY_COMMANDS = {
  "skills-list": {
    summary: "List the Box-wide (all bots) skill library, read through one bot",
    safety: "read-only",
    methods: [ROSTER],
    gatewayMethods: [SKILLS],
    params: { agent: AGENT, json: JSON_PARAM },
  },
  // `writes`, so a plain push needs no --yes. --replace also calls the destructive
  // deleteAgentWorkflow; the handler confirms that call itself, only with --replace --yes.
  "skills-push": {
    summary:
      "Import a SKILL.md into the Box-wide (all bots) skill library; --replace --yes overwrites an imported copy",
    safety: "writes",
    methods: [ROSTER],
    gatewayMethods: [SKILLS, "importAgentWorkflowText"],
    params: {
      agent: AGENT,
      file: {
        type: "string",
        description: "Path to the SKILL.md file (CLI only)",
        position: 1,
      },
      markdown: {
        type: "string",
        description: "The SKILL.md text, instead of a file",
      },
      name: {
        type: "string",
        description:
          "Skill name (default: the frontmatter name, else the file's folder name)",
      },
      replace: {
        type: "boolean",
        description:
          "Replace an imported skill of the same name whose content differs (needs yes)",
        default: false,
      },
      yes: {
        ...YES_PARAM,
        description: "Confirm --replace, which deletes the old copy first",
      },
      json: JSON_PARAM,
    },
  },
  "skills-remove": {
    summary:
      "Delete an imported skill from the Box-wide (all bots) skill library",
    safety: "destructive",
    methods: [ROSTER],
    gatewayMethods: [SKILLS, "deleteAgentWorkflow"],
    params: {
      agent: AGENT,
      skill: SKILL,
      "include-managed": INCLUDE_MANAGED,
      "force-protected": FORCE_PROTECTED,
      yes: YES_PARAM,
      json: JSON_PARAM,
    },
  },
  "skills-run": {
    summary:
      "Start an imported skill from the Box-wide (all bots) library on one bot (untested live)",
    safety: "writes",
    methods: [ROSTER],
    gatewayMethods: [SKILLS, "runAgentWorkflowNow"],
    params: {
      agent: AGENT,
      skill: SKILL,
      "include-managed": INCLUDE_MANAGED,
      json: JSON_PARAM,
    },
  },
} as const satisfies Record<string, CommandSpec>;
