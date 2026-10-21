import type { Agent } from "./agents.js";
import type { JobOutcome, RunOptions } from "./command-runner-contract.js";
import {
  dispatchMessage,
  followJob,
  type JobContext,
} from "./command-runner-jobs.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import type { Routine } from "./workforce-routines.js";

/** What a routine should be after a create or update. */
interface RoutineSpec {
  readonly name: string;
  readonly prompt: string;
  readonly trigger: JsonObject;
  readonly isEnabled: boolean;
}

/**
 * Bots on GrokBot's servers keep their routines on the server, and only the bot itself
 * can save them, with its UpdateRoutine tool. A room has no routines of its own.
 */
export function assertHasRoutines(agent: Agent): void {
  if (agent.kind === "room") {
    throw new GrokBotError(
      "not-found",
      `${agent.name} is a room, which has no routines of its own. Pass one of its bots.`,
    );
  }
}

/** The message that asks a bot to save a routine exactly as specified. */
export function routineInstruction(
  spec: RoutineSpec,
  current?: Routine,
): string {
  const ask = current
    ? `Change your routine "${current.name}" (id ${current.id || current.automationId}) with your UpdateRoutine tool so that it is exactly as below.`
    : "Create a routine for yourself with your UpdateRoutine tool, exactly as below.";
  return [
    ask,
    "Use the name, trigger and prompt word for word. Do not run the routine and do nothing else. When it is saved, reply with one word: Saved.",
    "",
    `Name: ${spec.name}`,
    `State: ${spec.isEnabled ? "on" : "off (paused)"}`,
    `Trigger (JSON): ${JSON.stringify(spec.trigger)}`,
    "Prompt (everything between the two marker lines):",
    "<<<PROMPT",
    spec.prompt,
    "PROMPT>>>",
  ].join("\n");
}

/** JSON with sorted keys, so two equal triggers compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sameTrigger = (a: JsonObject, b: JsonObject) =>
  canonical(a) === canonical(b);

/** How the saved routine differs from the spec; empty when it matches. */
export function routineDifferences(
  routine: Routine,
  spec: RoutineSpec,
): readonly string[] {
  return [
    routine.name.trim() !== spec.name.trim() && `its name is "${routine.name}"`,
    routine.prompt.trim() !== spec.prompt.trim() && "its prompt differs",
    !sameTrigger(routine.triggerConfig, spec.trigger) &&
      `its trigger is ${JSON.stringify(routine.triggerConfig)}`,
    routine.enabled !== spec.isEnabled &&
      `it is ${routine.enabled ? "on" : "off"}`,
  ].filter((d) => d !== false);
}

function outcomeText(outcome: JobOutcome): string {
  switch (outcome.status) {
    case "done":
      return `it replied: ${outcome.finalReply.slice(0, 200)}`;
    case "pending":
      return `no answer yet: ${outcome.reason}`;
    case "awaiting-approval":
      return "it waits for the owner's approval; answer the card in the app or with grokbot approvals";
    default:
      return "its reply was mixed with other work";
  }
}

/**
 * Asks the bot to save the routine, waits for its turn with the Done Rule, then reads the
 * routines back. Returns the saved routine only when it matches the spec exactly.
 */
export async function saveRoutineInChat(
  ctx: JobContext,
  agent: Agent,
  spec: RoutineSpec,
  options: {
    readonly current?: Routine;
    readonly timeoutSeconds: number;
    readonly find: (routines: readonly Routine[]) => Routine | undefined;
    readonly read: () => Promise<readonly Routine[]>;
    readonly run: RunOptions;
  },
): Promise<{ readonly routine: Routine; readonly jobId: string }> {
  const { run } = options;
  const job = await dispatchMessage(
    ctx,
    agent,
    routineInstruction(spec, options.current),
    run.signal,
  );
  const { jobId } = job;
  run.onEvent?.({ type: "dispatched", jobId, agentId: agent.agentId });
  const outcome = await followJob(ctx, job, options.timeoutSeconds, run);
  const routine = options.find(await options.read());
  if (routine) {
    const differences = routineDifferences(routine, spec);
    if (differences.length === 0) return { routine, jobId };
    throw new GrokBotError(
      "protocol",
      `${agent.name} saved routine ${routine.name} (${routine.automationId}), but ${differences.join("; ")}. Fix it with routines-update or delete it (job ${jobId}).`,
    );
  }
  throw new GrokBotError(
    outcome.status === "pending" ? "timeout" : "protocol",
    `${agent.name} has not saved routine "${spec.name}" yet (${outcomeText(outcome)}). The instruction may still be carried out, so do not send it again: check with grokbot wait ${jobId}, then routines-list.`,
  );
}
