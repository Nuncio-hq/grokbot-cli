import { randomUUID } from "node:crypto";
import { homedir, hostname as osHostname } from "node:os";
import {
  type Agent,
  noAgentError,
  parseListAgentsResponse,
  pickAgentQuery,
  resolveAgent,
} from "./agents.js";
import { createTokenSource } from "./auth-token-source.js";
import { type BoxStore, boxStore } from "./box-store.js";
import { detectCallerSession, hasSession } from "./caller-session.js";
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
import { INBOX_POLL_MS } from "./inbox-delivery.js";
import { type InboxStateStore, inboxStateStore } from "./inbox-state-store.js";
import { type JobOrigin, jobHandle } from "./job-queue.js";
import { jobStore } from "./job-store.js";
import { runtimeName, withMessageTag } from "./message-tag.js";
import { readPrimaryAgentId } from "./primary-agent.js";
import { type MatchedRoute, routeForFolder } from "./project-routes.js";
import {
  type ProjectRoutes,
  projectRoutesStore,
} from "./project-routes-store.js";
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
  /** aiserver.v1.BackgroundComposerService, for reading Cursor cloud agents. */
  readonly composer: ServerTransport;
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
  /**
   * Resolves the agent for a command meant for the account's primary Bot: `--agent`, else
   * the primary Bot. Never the host's default agent or a project route, which pick a bot
   * for one folder's work.
   */
  primaryTarget(flag: string | undefined, signal?: AbortSignal): Promise<Agent>;
  /** The working directory's project route label, if it has one (scopes the inbox list). */
  projectLabel(): Promise<string | undefined>;
  /**
   * The id and sender session of a job about to be sent. The id exists before the
   * message text does, because the header names the job.
   */
  beginJob(): Promise<JobOrigin>;
  /**
   * `text` behind grokbot's one header: the route's project label, the caller's runtime
   * name, the caller's session and the job `origin` names (first 8 characters of its id),
   * each when known, applied once. Every message sent for an agent goes through here,
   * except those that carry an instruction format (routines) or their own contract (inbox).
   */
  tagged(text: string, origin: JobOrigin): Promise<string>;
  /** The agent runtime's display name for messages with their own contract, if the caller is one. */
  runtime(): string | undefined;
  /**
   * The caller's session address (`<runtime>:<id>`), found afresh on every call from the
   * environment and the runtime's session folder; undefined when grokbot cannot tell which
   * session it runs in. It is the return address of a message and what an inbox item's
   * `to` is compared with. Never cached, so a long-lived host sees sessions as they change.
   */
  sessionAddress(): Promise<string | undefined>;
  /** Every project route, read again on each call. */
  projectRoutes(): Promise<ProjectRoutes>;
  /** The bots' cloud computer as the server mirrors it (inbox commands only). */
  readonly boxStore: BoxStore;
  /** What this computer did with inbox items. */
  readonly inboxState: InboxStateStore;
  /** This computer's short hostname, lowercase: what `grokbot computers` calls its label. */
  readonly hostname: string;
  /** Epoch ms now. */
  now(): number;
  /** How often `inbox wait` looks at the store's manifest. */
  readonly inboxPollMs: number;
  /** The longest `inbox wait` this host allows, in seconds; undefined for no cap. */
  readonly maxInboxWaitSeconds: number | undefined;
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

  const projectRoutes = () =>
    (options.projectRoutes ?? (() => projectRoutesStore().read()))();

  const now = options.now ?? Date.now;
  const sessionAddress = async () => {
    const session = await detectCallerSession({
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
      home: options.home ?? homedir(),
      now,
      caller: options.caller,
    });
    return hasSession(session) ? session.address : undefined;
  };

  return {
    server,
    jobs: options.jobs ?? jobStore(),
    gateway: options.gateway ?? createGatewayTransport({ server }),
    dashboard:
      options.dashboard ??
      createServerTransport({ getToken, service: "DashboardService" }),
    composer:
      options.composer ??
      createServerTransport({ getToken, service: "BackgroundComposerService" }),
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
    async primaryTarget(flag, signal) {
      const pick = pickAgentQuery({ flag });
      return pick
        ? resolveAgent(pick, await fetchAgents(signal))
        : primaryAgent(signal);
    },
    async projectLabel() {
      return (await routeHere())?.label;
    },
    async beginJob() {
      const session = await sessionAddress();
      return {
        jobId: randomUUID(),
        ...(session !== undefined && { session }),
      };
    },
    async tagged(text, { jobId, session }) {
      return withMessageTag(
        text,
        (await routeHere())?.label,
        options.caller,
        session,
        jobHandle(jobId),
      );
    },
    runtime: () => runtimeName(options.caller),
    sessionAddress,
    projectRoutes,
    boxStore: options.boxStore ?? boxStore({ server }),
    inboxState: options.inboxState ?? inboxStateStore(),
    hostname: (options.hostname ?? osHostname())
      .split(".")[0]
      ?.trim()
      .toLowerCase() as string,
    now,
    inboxPollMs: options.inboxPollMs ?? INBOX_POLL_MS,
    maxInboxWaitSeconds: options.maxInboxWaitSeconds,
  };
}
