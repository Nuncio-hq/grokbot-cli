import { resolveAgent } from "./agents.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import { asJsonObject } from "./transcript.js";
import { assertMayTouch } from "./workforce-protected-agents.js";
import {
  findRoutine,
  parseRoutines,
  type Routine,
} from "./workforce-routines.js";

type Names =
  | "routines-list"
  | "routines-enable"
  | "routines-disable"
  | "routines-delete"
  | "routines-create";

const LIST = "ListGrokBotAgentAutomations";
const SET_ENABLED = "SetGrokBotAgentAutomationEnabled";
const DELETE = "DeleteGrokBotAgentAutomation";

/**
 * The list a toggle replied with. Proto3 JSON drops an empty list, but a toggled
 * routine still exists, so a reply without one carries no list at all.
 */
const listIn = (reply: unknown, method: string) =>
  Array.isArray(asJsonObject(reply)?.automations)
    ? parseRoutines(reply, method)
    : undefined;

/** A bot's server-side routines (automations). */
export function routineHandlers(ctx: RunnerContext): CommandHandlers<Names> {
  const { server, gateway } = ctx;
  const agentOf = async (query: string, signal?: AbortSignal) =>
    resolveAgent(query, await ctx.fetchAgents(signal));
  const routinesOf = async (agentId: string, signal?: AbortSignal) =>
    parseRoutines(await server.call(LIST, { agentId }, { signal }), LIST);
  const setEnabled =
    (isEnabled: boolean, command: string) =>
    async (
      input: {
        readonly agent: string;
        readonly routine: string;
        readonly "force-protected"?: string;
      },
      { signal }: { readonly signal?: AbortSignal },
    ) => {
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(agent, input["force-protected"], command);
      const { automationId } = findRoutine(
        await routinesOf(agent.agentId, signal),
        input.routine,
      );
      const reply = await server.call(
        SET_ENABLED,
        { agentId: agent.agentId, automationId, isEnabled },
        { signal },
      );
      const after =
        listIn(reply, SET_ENABLED) ?? (await routinesOf(agent.agentId, signal));
      return { agent, routine: findRoutine(after, automationId) };
    };

  return {
    "routines-list": async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      return { agent, routines: await routinesOf(agent.agentId, signal) };
    },

    "routines-enable": setEnabled(true, "routines-enable"),
    "routines-disable": setEnabled(false, "routines-disable"),

    "routines-delete": async (input, { signal, confirmed }) => {
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(agent, input["force-protected"], "routines-delete");
      const routine = findRoutine(
        await routinesOf(agent.agentId, signal),
        input.routine,
      );
      const left = parseRoutines(
        await server.call(
          DELETE,
          { agentId: agent.agentId, automationId: routine.automationId },
          { signal, confirmed },
        ),
        DELETE,
      );
      return { agent, routine, remaining: left.length };
    },

    "routines-create": async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      const named = (routines: readonly Routine[]) =>
        routines.find(
          (r) =>
            r.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
        );
      const before = named(await routinesOf(agent.agentId, signal));
      if (before) return { agent, routine: before, result: "exists" };
      await gateway.call(
        "createAgentAutomation",
        {
          id: agent.agentId,
          spec: {
            name: input.name.trim(),
            prompt: input.prompt,
            trigger: { type: "cron", schedule: input.cron.trim() },
            isEnabled: true,
          },
        },
        { signal },
      );
      const routine = named(await routinesOf(agent.agentId, signal));
      if (!routine) {
        throw new GrokBotError(
          "protocol",
          `createAgentAutomation returned, but ${agent.name} has no routine "${input.name.trim()}".`,
        );
      }
      return { agent, routine, result: "created" };
    },
  };
}
