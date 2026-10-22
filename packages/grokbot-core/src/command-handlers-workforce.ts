import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import type { WorkforceCommandName } from "./command-specs-workforce.js";
import { fileHandlers } from "./workforce-file-handlers.js";
import { roomHandlers } from "./workforce-room-handlers.js";
import { routineHandlers } from "./workforce-routine-handlers.js";
import { routineWebhookHandlers } from "./workforce-routine-webhook-handlers.js";
import { skillHandlers } from "./workforce-skill-handlers.js";
import { staffHandlers } from "./workforce-staff-handlers.js";
import { teamHandlers } from "./workforce-team-handlers.js";

export function workforceHandlers(
  ctx: RunnerContext,
): CommandHandlers<WorkforceCommandName> {
  return {
    ...staffHandlers(ctx),
    ...roomHandlers(ctx),
    ...skillHandlers(ctx),
    ...fileHandlers(ctx),
    ...routineHandlers(ctx),
    ...routineWebhookHandlers(ctx),
    ...teamHandlers(ctx),
  };
}
