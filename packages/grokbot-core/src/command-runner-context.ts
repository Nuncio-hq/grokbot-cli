import {
  type Agent,
  parseListAgentsResponse,
  pickAgentQuery,
  resolveAgent,
} from "./agents.js";
import { createTokenSource } from "./auth-token-source.js";
import type { CommandInput, CommandName } from "./command-catalog.js";
import type {
  CommandOutput,
  CommandRunnerOptions,
  RunOptions,
} from "./command-runner-contract.js";
import type { JobContext } from "./command-runner-jobs.js";
import type { GatewayTransport } from "./contracts.js";
import { createGatewayTransport } from "./gateway-transport.js";
import { jobStore } from "./job-store.js";
import { createServerTransport } from "./server-transport.js";

/** What every command group's handlers share. Built once per runner. */
export interface RunnerContext extends JobContext {
  /** Box Gateway. EnsureSandBox runs on its first call, so commands that never call it never touch the box. */
  readonly gateway: GatewayTransport;
  fetchAgents(signal?: AbortSignal): Promise<readonly Agent[]>;
  /** Resolves `--agent`, else the host's default agent, against the live roster. */
  target(flag: string | undefined, signal?: AbortSignal): Promise<Agent>;
}

/** A handler's run options. Pass `confirmed` to every transport call. */
export interface HandlerRun extends RunOptions {
  /** True only for a destructive or sensitive command run with `yes`. */
  readonly confirmed: boolean;
}

export type CommandHandler<N extends CommandName> = (
  input: CommandInput<N>,
  run: HandlerRun,
) => Promise<CommandOutput<N>>;

/** One command group's handlers, exhaustive over the group's names. */
export type CommandHandlers<Names extends CommandName> = {
  readonly [N in Names]: CommandHandler<N>;
};

export function createRunnerContext(
  options: CommandRunnerOptions,
): RunnerContext {
  // `grokbot login`'s own sign-in first, else the desktop app's token (unchanged default).
  const tokens = createTokenSource();
  const server =
    options.server ??
    createServerTransport({ getToken: () => tokens.getToken() });

  const fetchAgents = async (signal?: AbortSignal) =>
    parseListAgentsResponse(
      await server.call("ListGrokBotAgents", {}, { signal }),
    );

  return {
    server,
    jobs: options.jobs ?? jobStore(),
    gateway: options.gateway ?? createGatewayTransport({ server }),
    fetchAgents,
    async target(flag, signal) {
      const pick = pickAgentQuery({ flag, env: options.defaultAgent });
      if (!pick.ok) throw pick.error;
      return resolveAgent(pick.query, await fetchAgents(signal));
    },
  };
}
