import { type Agent, resolveAgent } from "./agents.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import type { WebhookKeyRef } from "./routine-webhook-keys.js";
import { asJsonObject } from "./transcript.js";
import { assertMayTouch } from "./workforce-protected-agents.js";
import {
  routineDifferences,
  routinesViaChat,
  sameTrigger,
  saveRoutineInChat,
} from "./workforce-routine-chat.js";
import { triggerFromFlags } from "./workforce-routine-triggers.js";
import {
  findRoutine,
  isWebhookRoutine,
  parseRoutines,
  type Routine,
} from "./workforce-routines.js";

type Names =
  | "routines-list"
  | "routines-enable"
  | "routines-disable"
  | "routines-delete"
  | "routines-create"
  | "routines-update"
  | "routines-run";

const LIST = "ListGrokBotAgentAutomations";
const SET_ENABLED = "SetGrokBotAgentAutomationEnabled";
const DELETE = "DeleteGrokBotAgentAutomation";
const NO_TRIGGER =
  "Name a trigger: --cron, --webhook, --email, --github, --trigger, or --trigger-file.";

/**
 * The list a toggle replied with. Proto3 JSON drops an empty list, but a toggled
 * routine still exists, so a reply without one carries no list at all.
 */
const listIn = (reply: unknown, method: string) =>
  Array.isArray(asJsonObject(reply)?.automations)
    ? parseRoutines(reply, method)
    : undefined;

/** The Box keeps routines as records and names them by record id, as the app does. */
export const boxRoutineId = (routine: Routine) =>
  routine.id === "" ? routine.automationId : routine.id;

/** Which Keychain item holds a routine's webhook key. */
export const webhookKeyRef = (
  agent: Agent,
  routine: Routine,
): WebhookKeyRef => ({
  agentId: agent.agentId,
  automationId: routine.automationId,
  createdAt: routine.createdAt,
});

/** Resolve a bot and read its routines, the first step of every routine command. */
export function routineReads(ctx: RunnerContext) {
  return {
    agentOf: async (query: string, signal?: AbortSignal) =>
      resolveAgent(query, await ctx.fetchAgents(signal)),
    routinesOf: async (agentId: string, signal?: AbortSignal) =>
      parseRoutines(await ctx.server.call(LIST, { agentId }, { signal }), LIST),
  };
}

/** A bot's server-side routines (automations). */
export function routineHandlers(ctx: RunnerContext): CommandHandlers<Names> {
  const { server, gateway } = ctx;
  const { agentOf, routinesOf } = routineReads(ctx);
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
      assertMayTouch(
        agent,
        input["force-protected"],
        command,
        await ctx.protectedBots(),
      );
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
      assertMayTouch(
        agent,
        input["force-protected"],
        "routines-delete",
        await ctx.protectedBots(),
      );
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
      // Deleting the routine ends all its keys on the server, so the local copy goes
      // after it, and only for webhook routines: other routines never need the Keychain.
      if (!isWebhookRoutine(routine))
        return {
          agent,
          routine,
          remaining: left.length,
          webhookKeyRemoved: false,
        };
      try {
        const webhookKeyRemoved = await ctx.webhookKeys.remove(
          webhookKeyRef(agent, routine),
        );
        return { agent, routine, remaining: left.length, webhookKeyRemoved };
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new GrokBotError(
          "protocol",
          `Deleted routine ${routine.name} (${routine.automationId}), so its keys no longer work, but its Keychain item could not be removed: ${why}`,
        );
      }
    },

    "routines-create": async (input, run) => {
      const { signal } = run;
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(
        agent,
        input["force-protected"],
        "routines-create",
        await ctx.protectedBots(),
      );
      const trigger = await triggerFromFlags(input);
      if (trigger === undefined)
        throw new GrokBotError("not-found", NO_TRIGGER);
      const name = input.name.trim();
      const named = (routines: readonly Routine[]) =>
        routines.find(
          (r) => r.name.trim().toLowerCase() === name.toLowerCase(),
        );
      const before = named(await routinesOf(agent.agentId, signal));
      if (before) return { agent, routine: before, result: "exists" };
      const spec = {
        name,
        prompt: input.prompt,
        trigger,
        isEnabled: !input.paused,
      };
      if (routinesViaChat(agent)) {
        const saved = await saveRoutineInChat(ctx, agent, spec, {
          timeoutSeconds: input.timeout,
          find: named,
          read: () => routinesOf(agent.agentId, signal),
          run,
        });
        return { agent, ...saved, result: "created" };
      }
      await gateway.call(
        "createAgentAutomation",
        { id: agent.agentId, spec },
        { signal },
      );
      const routine = named(await routinesOf(agent.agentId, signal));
      if (!routine) {
        throw new GrokBotError(
          "protocol",
          `createAgentAutomation returned, but ${agent.name} has no routine "${name}".`,
        );
      }
      return { agent, routine, result: "created" };
    },

    "routines-update": async (input, run) => {
      const { signal } = run;
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(
        agent,
        input["force-protected"],
        "routines-update",
        await ctx.protectedBots(),
      );
      const trigger = await triggerFromFlags(input);
      const name = input.name?.trim();
      if (name === undefined && input.prompt === undefined && !trigger) {
        throw new GrokBotError(
          "not-found",
          `Pass what to change: --name, --prompt, or a trigger. ${NO_TRIGGER}`,
        );
      }
      const current = findRoutine(
        await routinesOf(agent.agentId, signal),
        input.routine,
      );
      // Both paths replace the whole routine, so unchanged fields are sent as they are.
      const spec = {
        name: name || current.name,
        prompt: input.prompt ?? current.prompt,
        trigger: trigger ?? current.triggerConfig,
        isEnabled: current.enabled,
      };
      const changed = [
        spec.name !== current.name && ("name" as const),
        spec.prompt !== current.prompt && ("prompt" as const),
        !sameTrigger(spec.trigger, current.triggerConfig) &&
          ("trigger" as const),
      ].filter((field) => field !== false);
      if (changed.length === 0) return { agent, routine: current, changed };
      const sameRoutine = (routines: readonly Routine[]) =>
        routines.find((r) => r.automationId === current.automationId);
      if (routinesViaChat(agent)) {
        const saved = await saveRoutineInChat(ctx, agent, spec, {
          current,
          timeoutSeconds: input.timeout,
          find: sameRoutine,
          read: () => routinesOf(agent.agentId, signal),
          run,
        });
        return { agent, ...saved, changed };
      }
      await gateway.call(
        "updateAgentAutomation",
        { id: agent.agentId, automationId: boxRoutineId(current), spec },
        { signal },
      );
      const after = findRoutine(
        await routinesOf(agent.agentId, signal),
        current.automationId,
      );
      const differences = routineDifferences(after, spec);
      if (differences.length > 0) {
        throw new GrokBotError(
          "protocol",
          `updateAgentAutomation returned, but ${after.name}: ${differences.join("; ")}.`,
        );
      }
      return { agent, routine: after, changed };
    },

    "routines-run": async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      const routine = findRoutine(
        await routinesOf(agent.agentId, signal),
        input.routine,
      );
      if (routinesViaChat(agent)) {
        throw new GrokBotError(
          "not-found",
          `${agent.name} runs on GrokBot's servers, where a routine cannot be started on demand (the Box refuses it). Give it a webhook trigger and use grokbot routines-fire, or ask the bot.`,
        );
      }
      await gateway.call(
        "runAgentAutomationNow",
        { id: agent.agentId, automationId: boxRoutineId(routine) },
        { signal },
      );
      return { agent, routine };
    },
  };
}
