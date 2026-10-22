import { updateNotice } from "./bots-version-store.js";
import { COMMANDS, type CommandName } from "./command-catalog.js";
import { dispatchHandlers } from "./command-handlers-dispatch.js";
import { governanceHandlers } from "./command-handlers-governance.js";
import { inboxHandlers } from "./command-handlers-inbox.js";
import { workforceHandlers } from "./command-handlers-workforce.js";
import {
  type CommandHandlers,
  createRunnerContext,
} from "./command-runner-context.js";
import type {
  CommandRunner,
  CommandRunnerOptions,
} from "./command-runner-contract.js";
import { confirmedFor } from "./command-spec.js";
import { INBOX_COMMANDS } from "./command-specs-inbox.js";
import { inboxNotice } from "./inbox-delivery.js";
import { GROKBOT_VERSION } from "./version.js";

export function createCommandRunner(
  options: CommandRunnerOptions = {},
): CommandRunner {
  const ctx = createRunnerContext(options);
  const handlers: CommandHandlers<CommandName> = {
    ...dispatchHandlers(ctx),
    ...workforceHandlers(ctx),
    ...governanceHandlers(ctx),
    ...inboxHandlers(ctx),
  };

  return {
    async run(name, input, runOptions = {}) {
      // Throws before any network call when a destructive or sensitive command lacks `yes`.
      const confirmed = confirmedFor(name, COMMANDS[name].safety, input);
      const output = await handlers[name](input, {
        ...runOptions,
        confirmed,
      });
      // Every other command rides a catch-up notice for what the bots left this session.
      const inbox =
        name in INBOX_COMMANDS
          ? undefined
          : await inboxNotice(ctx, runOptions.signal);
      // And, while the bots run another grokbot than this computer, a nudge to update them.
      const update =
        name === "update-bots" || name === "setup-bots"
          ? undefined
          : await updateNotice(ctx.botsVersion, GROKBOT_VERSION, ctx.now());
      return {
        ...output,
        ...(inbox !== undefined && { inboxNotice: inbox }),
        ...(update !== undefined && { updateNotice: update }),
      };
    },
  };
}
