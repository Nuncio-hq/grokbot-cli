import { COMMANDS, type CommandName } from "./command-catalog.js";
import { dispatchHandlers } from "./command-handlers-dispatch.js";
import { governanceHandlers } from "./command-handlers-governance.js";
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

export function createCommandRunner(
  options: CommandRunnerOptions = {},
): CommandRunner {
  const ctx = createRunnerContext(options);
  const handlers: CommandHandlers<CommandName> = {
    ...dispatchHandlers(ctx),
    ...workforceHandlers(ctx),
    ...governanceHandlers(ctx),
  };

  return {
    async run(name, input, runOptions = {}) {
      // Throws before any network call when a destructive or sensitive command lacks `yes`.
      const confirmed = confirmedFor(name, COMMANDS[name].safety, input);
      return handlers[name](input, { ...runOptions, confirmed });
    },
  };
}
