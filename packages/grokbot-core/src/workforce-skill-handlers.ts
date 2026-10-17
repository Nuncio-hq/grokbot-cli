import { resolveAgent } from "./agents.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import { readInputFile } from "./workforce-handler-helpers.js";
import { assertMayTouch } from "./workforce-protected-agents.js";
import {
  BOX_WIDE,
  findSkill,
  parseImportReply,
  parseLibrary,
  pushTarget,
  sameContent,
  skillName,
  toListedSkill,
  toSkill,
} from "./workforce-skills.js";

type Names = "skills-list" | "skills-push" | "skills-remove" | "skills-run";

const IMPORT = "importAgentWorkflowText";
const DELETE = "deleteAgentWorkflow";

/** The SKILL.md text from exactly one of `markdown` (MCP and CLI) or `file` (CLI only). */
async function skillText(input: {
  readonly file?: string;
  readonly markdown?: string;
}): Promise<string> {
  if (input.file !== undefined && input.markdown !== undefined) {
    throw new GrokBotError(
      "not-found",
      "Pass a SKILL.md path or markdown, not both.",
    );
  }
  if (input.markdown !== undefined) return input.markdown;
  if (input.file !== undefined) {
    return readInputFile(input.file, "SKILL.md file");
  }
  throw new GrokBotError(
    "not-found",
    "skills-push needs the skill text: a SKILL.md path, or markdown.",
  );
}

/** The Cloud Box skill library. It is Box-wide: the bot only picks whose gateway call it is. */
export function skillHandlers(ctx: RunnerContext): CommandHandlers<Names> {
  const { gateway } = ctx;
  const agentOf = async (query: string, signal?: AbortSignal) =>
    resolveAgent(query, await ctx.fetchAgents(signal));
  const libraryOf = async (agentId: string, signal?: AbortSignal) =>
    parseLibrary(
      await gateway.call("getAgentWorkflows", { id: agentId }, { signal }),
      "getAgentWorkflows",
    );

  return {
    "skills-list": async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      return {
        agent,
        skills: (await libraryOf(agent.agentId, signal)).map(toListedSkill),
      };
    },

    "skills-push": async (input, { signal }) => {
      if (input.replace && !input.yes) {
        throw new GrokBotError(
          "safety",
          "skills-push --replace first deletes the old copy for every bot. Re-run with --replace --yes.",
        );
      }
      const markdown = await skillText(input);
      const name = input.name?.trim() || skillName(markdown, input.file);
      if (!name) {
        throw new GrokBotError(
          "not-found",
          'skills-push needs a name: add "name:" to the frontmatter, or pass --name.',
        );
      }
      const agent = await agentOf(input.agent, signal);
      const found = pushTarget(await libraryOf(agent.agentId, signal), name);
      const same = found && sameContent(found, markdown);
      if (found && same) {
        return { agent, skill: toSkill(found), result: "unchanged" };
      }
      if (found && !input.replace) {
        if (same === undefined) {
          return { agent, skill: toSkill(found), result: "exists" };
        }
        throw new GrokBotError(
          "ambiguous",
          `The ${BOX_WIDE} already has a different "${found.name}" (${found.id}). Re-run with --replace --yes to replace it for every bot.`,
        );
      }
      if (found) {
        await gateway.call(
          DELETE,
          { id: agent.agentId, workflowId: found.id },
          { signal, confirmed: true },
        );
      }
      const [skill] = parseImportReply(
        await gateway.call(
          IMPORT,
          { id: agent.agentId, markdown, name },
          { signal },
        ),
      );
      if (!skill) {
        throw new GrokBotError(
          "protocol",
          `${IMPORT} imported nothing for ${name}${found ? ` after deleting ${found.id}; push again without --replace to restore it` : ""}.`,
        );
      }
      return { agent, skill, result: found ? "replaced" : "imported" };
    },

    "skills-remove": async (input, { signal, confirmed }) => {
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(agent, input["force-protected"], "skills-remove");
      const skill = findSkill(
        await libraryOf(agent.agentId, signal),
        input.skill,
        input["include-managed"],
      );
      const left = parseLibrary(
        await gateway.call(
          DELETE,
          { id: agent.agentId, workflowId: skill.id },
          { signal, confirmed },
        ),
        DELETE,
      );
      return { agent, skill: toSkill(skill), remaining: left.length };
    },

    "skills-run": async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      const skill = findSkill(
        await libraryOf(agent.agentId, signal),
        input.skill,
        input["include-managed"],
      );
      await gateway.call(
        "runAgentWorkflowNow",
        { id: agent.agentId, workflowId: skill.id },
        { signal },
      );
      return { agent, skill: toSkill(skill) };
    },
  };
}
