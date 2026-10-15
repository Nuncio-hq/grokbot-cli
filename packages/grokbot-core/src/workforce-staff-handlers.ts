import { randomUUID } from "node:crypto";
import { type Agent, type AgentId, resolveAgent } from "./agents.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import {
  createWithClientId,
  namedLike,
  readInputFile,
} from "./workforce-handler-helpers.js";
import { pendingHiresBeside } from "./workforce-pending-hires.js";
import {
  composeBrief,
  gatewayProfile,
  mergeProfile,
  type ProfileChange,
  parseBrief,
  staffFolder,
} from "./workforce-profile.js";
import { assertMayTouch } from "./workforce-protected-agents.js";

type Names = "hire" | "update" | "fire";

/** Instructions from exactly one of `instructions` (MCP and CLI) or `instructions-file` (CLI only). */
async function instructionsOf(input: {
  readonly instructions?: string;
  readonly "instructions-file"?: string;
}): Promise<string | undefined> {
  const file = input["instructions-file"];
  if (file !== undefined && input.instructions !== undefined) {
    throw new GrokBotError(
      "not-found",
      "Pass --instructions or --instructions-file, not both.",
    );
  }
  return file === undefined
    ? input.instructions
    : readInputFile(file, "--instructions-file");
}

/** A same-name bot is ours to brief again only if `hire` gave it a folder. */
function adoptable(roster: readonly Agent[], name: string): Agent | undefined {
  const [same, ...more] = namedLike(roster, name);
  if (!same) return undefined;
  const folder = parseBrief(same.description).folder;
  if (more.length > 0 || same.kind !== "agent" || folder === undefined) {
    throw new GrokBotError(
      "ambiguous",
      `A bot named "${same.name}" already exists (${same.agentId}). Pick another name, or change that bot with grokbot update.`,
    );
  }
  return same;
}

export function staffHandlers(ctx: RunnerContext): CommandHandlers<Names> {
  const { server, gateway } = ctx;
  const pending = pendingHiresBeside(ctx.jobs.dir);
  return {
    hire: async (input, { signal }) => {
      const instructions = await instructionsOf(input);
      const roster = await ctx.fetchAgents(signal);
      const existing = adoptable(roster, input.name);
      const agentId =
        existing?.agentId ??
        (await pending.load(input.name)) ??
        (randomUUID() as AgentId);
      const before = existing && parseBrief(existing.description);
      const folder = before?.folder ?? staffFolder(input.name, agentId, roster);
      const profile = {
        name: input.name.trim(),
        title: input.title.trim(),
        description: composeBrief({
          summary: input.description,
          instructions: instructions ?? before?.instructions ?? "",
          folder,
        }),
      };
      if (!existing) await pending.save(input.name, agentId);
      const agent =
        existing ??
        (await createWithClientId(
          ctx,
          "CreateGrokBotTemporalAgent",
          {
            agentId,
            ...profile,
            avatarShape: "blob",
            avatarColor: "black",
            harness: "GROK_BOT_AGENT_HARNESS_TEMPORAL",
            kickstartRequested: false,
            introductionSuppressed: true,
            language: "en",
          },
          "Run the same hire again; it reuses that id.",
          signal,
        ));
      await pending.clear(input.name);
      try {
        await gateway.call("updateAgent", { id: agentId, profile }, { signal });
      } catch (error) {
        if (!(error instanceof GrokBotError)) throw error;
        throw new GrokBotError(
          error.code,
          `${existing ? "Found" : "Created"} ${agent.name} but could not brief it (${error.message}). Run the same hire again to finish.`,
          { cause: error },
        );
      }
      return {
        agent: { ...agent, ...profile },
        folder,
        result: existing ? "adopted" : "created",
      };
    },

    update: async (input, { signal }) => {
      const instructions = await instructionsOf(input);
      const change: ProfileChange = {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(instructions !== undefined && { instructions }),
      };
      if (Object.keys(change).length === 0) {
        throw new GrokBotError(
          "not-found",
          "Nothing to update. Pass --title, --description, --instructions, or --instructions-file.",
        );
      }
      const agent = resolveAgent(input.agent, await ctx.fetchAgents(signal));
      const current = gatewayProfile(
        await gateway.call("listAgents", {}, { signal }),
        agent.agentId,
      );
      const { profile, changed } = mergeProfile(current, change);
      if (changed.length === 0) return { agent, changed };
      await gateway.call(
        "updateAgent",
        { id: agent.agentId, profile },
        { signal },
      );
      const after = (await ctx.fetchAgents(signal)).find(
        (a) => a.agentId === agent.agentId,
      );
      if (
        after?.description !== profile.description ||
        (profile.title !== undefined && after.title !== profile.title)
      ) {
        throw new GrokBotError(
          "protocol",
          `updateAgent accepted the change, but ListGrokBotAgents does not show it yet for ${agent.name}.`,
        );
      }
      return { agent: after, changed };
    },

    fire: async (input, { signal, confirmed }) => {
      const agent = resolveAgent(input.agent, await ctx.fetchAgents(signal));
      assertMayTouch(agent, input["force-protected"], "fire");
      await server.call(
        "DeleteGrokBotAgent",
        { id: agent.agentId },
        { signal, confirmed },
      );
      return { agent };
    },
  };
}
