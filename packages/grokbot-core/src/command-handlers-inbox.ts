import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import type { InboxCommandName } from "./command-specs-inbox.js";
import { checkInbox, waitInbox } from "./inbox-delivery.js";
import { fetchInbox } from "./inbox-fetch-handlers.js";
import { closeInbox, replyInbox } from "./inbox-send-handlers.js";
import { listInbox, showInboxItem } from "./inbox-view-handlers.js";

export function inboxHandlers(
  ctx: RunnerContext,
): CommandHandlers<InboxCommandName> {
  return {
    inbox: (input, { signal }) => listInbox(ctx, input, signal),
    "inbox-show": (input, { signal }) => showInboxItem(ctx, input.id, signal),
    "inbox-fetch": (input, { signal }) => fetchInbox(ctx, input, signal),
    "inbox-reply": (input, run) => replyInbox(ctx, input, run),
    "inbox-done": (input, run) => closeInbox(ctx, input, run),
    "inbox-wait": (input, { signal }) => waitInbox(ctx, input, signal),
    "inbox-check": (_input, { signal }) => checkInbox(ctx, signal),
  };
}
