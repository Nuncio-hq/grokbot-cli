import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { webhookUrl } from "./routine-webhook.js";
import { asJsonObject, readString } from "./transcript.js";
import { readInputFile } from "./workforce-handler-helpers.js";
import { assertMayTouch } from "./workforce-protected-agents.js";
import { routineReads, webhookKeyRef } from "./workforce-routine-handlers.js";
import {
  findRoutine,
  isWebhookRoutine,
  type Routine,
} from "./workforce-routines.js";

type Names = "routines-webhook-key" | "routines-fire";

const MINT = "CreateAutomationWebhookApiKey";

function assertWebhook(routine: Routine, command: string): void {
  if (isWebhookRoutine(routine)) return;
  throw new GrokBotError(
    "not-found",
    `${routine.name} fires on ${routine.trigger || "no trigger"}, not a webhook, so ${command} does not apply.`,
  );
}

/** The JSON body from `payload` (MCP and CLI) or `payload-file` (CLI only); default `{}`. */
async function payloadOf(input: {
  readonly payload?: string;
  readonly "payload-file"?: string;
}): Promise<JsonObject> {
  const file = input["payload-file"];
  if (input.payload !== undefined && file !== undefined) {
    throw new GrokBotError(
      "not-found",
      "Pass a payload or a payload file, not both.",
    );
  }
  const text =
    input.payload ??
    (file === undefined
      ? undefined
      : await readInputFile(file, "payload file"));
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GrokBotError("not-found", "The payload is not valid JSON.");
  }
  const body = asJsonObject(parsed);
  if (!body) {
    throw new GrokBotError("not-found", "The payload must be a JSON object.");
  }
  return body;
}

/** Webhook routines: a key minted into the Keychain, and a POST that fires the routine. */
export function routineWebhookHandlers(
  ctx: RunnerContext,
): CommandHandlers<Names> {
  const { agentOf, routinesOf } = routineReads(ctx);
  return {
    "routines-webhook-key": async (input, { signal, confirmed }) => {
      const agent = await agentOf(input.agent, signal);
      assertMayTouch(
        agent,
        input["force-protected"],
        "routines-webhook-key",
        await ctx.protectedBots(),
      );
      const routine = findRoutine(
        await routinesOf(agent.agentId, signal),
        input.routine,
      );
      assertWebhook(routine, "routines-webhook-key");
      const ref = webhookKeyRef(agent, routine);
      const found = {
        agent,
        routine,
        url: webhookUrl(routine.automationId),
        keychainItem: ctx.webhookKeys.item(ref),
      };
      // One key per routine, as in the app: mint only when none is stored, or on replace.
      const stored = (await ctx.webhookKeys.load(ref)) !== undefined;
      if (stored && !input.replace) return { ...found, result: "exists" };
      const reply = await ctx.dashboard.call(
        MINT,
        { automationId: routine.automationId },
        { signal, confirmed },
      );
      const key = readString(asJsonObject(reply) ?? {}, "apiKey");
      if (!key)
        throw new GrokBotError("protocol", `${MINT} returned no apiKey.`);
      try {
        await ctx.webhookKeys.save(ref, key);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new GrokBotError(
          "auth",
          `A key was minted but could not be stored here: ${why} The server still accepts it until the routine is deleted. Fix the Keychain and mint another.`,
          { cause: error },
        );
      }
      return { ...found, result: stored ? "replaced" : "minted" };
    },

    "routines-fire": async (input, { signal }) => {
      const agent = await agentOf(input.agent, signal);
      const routine = findRoutine(
        await routinesOf(agent.agentId, signal),
        input.routine,
      );
      assertWebhook(routine, "routines-fire");
      const body = await payloadOf(input);
      const key = await ctx.webhookKeys.load(webhookKeyRef(agent, routine));
      if (!key) {
        throw new GrokBotError(
          "not-found",
          `No webhook key for ${routine.name} in the Keychain. The owner mints one with grokbot routines-webhook-key "${agent.name}" "${routine.name}" --yes.`,
        );
      }
      const url = webhookUrl(routine.automationId);
      const { status, reply } = await ctx.fireWebhook(url, key, body, signal);
      return { agent, routine, url, status, reply };
    },
  };
}
