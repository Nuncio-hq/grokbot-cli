import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import type { WorkforceCommandName } from "./command-specs-workforce.js";
import { roomHandlers } from "./workforce-room-handlers.js";
import { routineHandlers } from "./workforce-routine-handlers.js";
import { routineWebhookHandlers } from "./workforce-routine-webhook-handlers.js";
import { skillHandlers } from "./workforce-skill-handlers.js";
import { staffHandlers } from "./workforce-staff-handlers.js";

export function workforceHandlers(
  ctx: RunnerContext,
): CommandHandlers<WorkforceCommandName> {
  return {
    ...staffHandlers(ctx),
    ...roomHandlers(ctx),
    ...skillHandlers(ctx),
    ...routineHandlers(ctx),
    ...routineWebhookHandlers(ctx),
  };
}
