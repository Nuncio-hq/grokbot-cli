import {
  type Agent,
  noAgentError,
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
import {
  type GatewayTransport,
  GrokBotError,
  type ServerTransport,
} from "./contracts.js";
import { createGatewayTransport } from "./gateway-transport.js";
import { jobStore } from "./job-store.js";
import { readPrimaryAgentId } from "./primary-agent.js";
import { type MatchedRoute, routeForFolder } from "./project-routes.js";
import { projectRoutesStore } from "./project-routes-store.js";
import {
  type ProtectedBots,
  protectedBotsStore,
} from "./protected-bots-store.js";
import { createWebhookFirer, type WebhookFirer } from "./routine-webhook.js";
import {
  type WebhookKeyStore,
  webhookKeyStore,
} from "./routine-webhook-keys.js";
import { createServerTransport } from "./server-transport.js";

/** What every command group's handlers share. Built once per runner. */
export interface RunnerContext extends JobContext {
  /** Box Gateway. EnsureSandBox runs on its first call, so commands that never call it never touch the box. */
  readonly gateway: GatewayTransport;
  /** aiserver.v1.DashboardService, for minting routine webhook keys. */
  readonly dashboard: Pick<ServerTransport, "call">;
  readonly webhookKeys: WebhookKeyStore;
  readonly fireWebhook: WebhookFirer;
  fetchAgents(signal?: AbortSignal): Promise<readonly Agent[]>;
  /** The bots the user marked on this computer; throws if that list is unreadable. */
  protectedBots(): Promise<ProtectedBots>;
  /**
   * Resolves the agent against the live roster: `--agent`, else the host's default agent,
   * else the working directory's project route, else the account's primary Bot.
   */
  target(flag: string | undefined, signal?: AbortSignal): Promise<Agent>;
  /** The `[label] ` tag of the working directory's project route, if it has one. */
  projectLabel(): Promise<string | undefined>;
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
  const getToken = () => tokens.getToken();
  const server = options.server ?? createServerTransport({ getToken });

  const fetchAgents = async (signal?: AbortSignal) =>
    parseListAgentsResponse(
      await server.call("ListGrokBotAgents", {}, { signal }),
    );

  const routeHere = async (): Promise<MatchedRoute | undefined> =>
    routeForFolder(
      await (options.projectRoutes ?? (() => projectRoutesStore().read()))(),
      options.cwd ?? process.cwd(),
    );

  const byAgentId = (
    agents: readonly Agent[],
    agentId: string,
    what: string,
  ) => {
    const agent = agents.find((a) => a.agentId === agentId);
    if (agent) return agent;
    throw new GrokBotError(
      "not-found",
      `${what} points at agent ${agentId}, which is not on this account. Check grokbot agents.`,
    );
  };

  /** The account's primary Bot, from the user's runtime settings. */
  const primaryAgent = async (signal?: AbortSignal) => {
    const id = await readPrimaryAgentId(server, signal);
    if (id === undefined) throw noAgentError();
    return byAgentId(
      await fetchAgents(signal),
      id,
      "The account's primary Bot",
    );
  };

  return {
    server,
    jobs: options.jobs ?? jobStore(),
    gateway: options.gateway ?? createGatewayTransport({ server }),
    dashboard:
      options.dashboard ??
      createServerTransport({ getToken, service: "DashboardService" }),
    webhookKeys: options.webhookKeys ?? webhookKeyStore(),
    fireWebhook: options.fireWebhook ?? createWebhookFirer(),
    fetchAgents,
    protectedBots: options.protectedBots ?? (() => protectedBotsStore().read()),
    async target(flag, signal) {
      const pick = pickAgentQuery({ flag, env: options.defaultAgent });
      if (pick) return resolveAgent(pick, await fetchAgents(signal));
      const route = await routeHere();
      if (route) {
        return byAgentId(
          await fetchAgents(signal),
          route.agentId,
          `The project route ${route.match}`,
        );
      }
      return primaryAgent(signal);
    },
    async projectLabel() {
      return (await routeHere())?.label;
    },
  };
}
