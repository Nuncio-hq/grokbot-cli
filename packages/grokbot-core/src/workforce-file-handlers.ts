import { resolveAgent } from "./agents.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import {
  type BotFile,
  findFile,
  listOnlyYouFiles,
  listTeamFiles,
  parseSection,
  REMOVE_ONLY_YOU_FILE,
  REMOVE_TEAM_FILE,
  type TeamSection,
} from "./workforce-files.js";
import { assertMayTouch } from "./workforce-protected-agents.js";

type Names = "files" | "files-remove";

const NO_TEAM: TeamSection = { totalBytes: 0, canEdit: false, complete: true };

/** A bot's files: the team section, then the user's private one. */
export function fileHandlers(ctx: RunnerContext): CommandHandlers<Names> {
  const { server } = ctx;
  const agentOf = async (query: string, signal?: AbortSignal) =>
    resolveAgent(query, await ctx.fetchAgents(signal));

  return {
    files: async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      const [{ files: team, ...section }, mine] = await Promise.all([
        listTeamFiles(server, agent.agentId, signal),
        listOnlyYouFiles(server, agent.agentId, signal),
      ]);
      return { agent, files: [...team, ...mine], team: section };
    },

    "files-remove": async (input, { signal, confirmed }) => {
      const only = parseSection(input.section);
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(
        agent,
        input["force-protected"],
        "files-remove",
        await ctx.protectedBots(),
      );
      const team =
        only === "only-you"
          ? undefined
          : await listTeamFiles(server, agent.agentId, signal);
      const mine =
        only === "team"
          ? []
          : await listOnlyYouFiles(server, agent.agentId, signal);
      const file: BotFile = findFile(
        [...(team?.files ?? []), ...mine],
        input.path,
        { section: only, complete: (team ?? NO_TEAM).complete },
      );
      if (file.section === "team") {
        if (team?.canEdit !== true) {
          throw new GrokBotError(
            "safety",
            `You cannot edit the team files of ${agent.name}, so ${file.name} stays. Only the team files' editors can remove them.`,
          );
        }
        await server.call(
          REMOVE_TEAM_FILE,
          { agentId: agent.agentId, name: file.name },
          { signal, confirmed },
        );
      } else {
        await server.call(
          REMOVE_ONLY_YOU_FILE,
          { agentId: agent.agentId, path: file.path },
          { signal, confirmed },
        );
      }
      return { agent, file };
    },
  };
}
