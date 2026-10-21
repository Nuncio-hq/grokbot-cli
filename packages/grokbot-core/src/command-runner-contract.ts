import type { BoxStore } from "./box-store.js";
import type { CommandInput, CommandName } from "./command-catalog.js";
import type { DispatchOutputs } from "./command-outputs-dispatch.js";
import type { GovernanceOutputs } from "./command-outputs-governance.js";
import type { InboxNotice, InboxOutputs } from "./command-outputs-inbox.js";
import type { WorkforceOutputs } from "./command-outputs-workforce.js";
import type { GatewayTransport, ServerTransport } from "./contracts.js";
import type { InboxStateStore } from "./inbox-state-store.js";
import type { JobStore } from "./job-store.js";
import type { ProjectRoutes } from "./project-routes-store.js";
import type { ProtectedBots } from "./protected-bots-store.js";
import type { WebhookFirer } from "./routine-webhook.js";
import type { WebhookKeyStore } from "./routine-webhook-keys.js";
import type { ClientLabel } from "./usage-client.js";
import type { WaitEvent } from "./wait-for-done.js";

export type {
  JobOutcome,
  TeamMember,
} from "./command-outputs-dispatch.js";

export interface CommandRunnerOptions {
  /** Default: createServerTransport over createTokenSource() (CLI sign-in, else the app's token). */
  readonly server?: ServerTransport;
  /** Default: createGatewayTransport({ server }), which runs EnsureSandBox on its first call. */
  readonly gateway?: GatewayTransport;
  /** Default: jobStore() at ~/.grokbot/jobs. */
  readonly jobs?: JobStore;
  /** Default: createServerTransport for DashboardService, with the same sign-in as `server`. */
  readonly dashboard?: Pick<ServerTransport, "call">;
  /** Default: createServerTransport for BackgroundComposerService (cloud agents), with the same sign-in as `server`. */
  readonly composer?: ServerTransport;
  /** Default: webhookKeyStore() in the macOS Keychain. */
  readonly webhookKeys?: WebhookKeyStore;
  /** Default: createWebhookFirer() over proxy-aware fetch (see proxy-config.ts). */
  readonly fireWebhook?: WebhookFirer;
  /**
   * Used when a command gets no `agent` input. Hosts pass process.env.GROKBOT_AGENT.
   * Resolution order: `agent` input, this, the project route for `cwd`, the account's primary Bot.
   */
  readonly defaultAgent?: string;
  /**
   * Who is calling, as `detectClient` labels it: the CLI host (env + stdin TTY) and the MCP
   * host (env + the client's name) compute it once. It heads every message grokbot sends
   * for an agent with the agent runtime's name and session (when it can tell which), so the
   * agent never has to name itself and a bot can address a reply to that session.
   * Without it (a library host) messages carry the project label alone.
   */
  readonly caller?: ClientLabel;
  /**
   * Where the caller's session is read from (GROKBOT_SESSION, CODEX_THREAD_ID, and the
   * variables that relocate an agent's session folder). Default: process.env.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The home folder agent runtimes keep their sessions under. Default: os.homedir(). */
  readonly home?: string;
  /** The folder whose project route applies, and whose session folder is looked up. Default: process.cwd(). */
  readonly cwd?: string;
  /** Default: projectRoutesStore().read(), read again on every call so edits apply at once. */
  readonly projectRoutes?: () => Promise<ProjectRoutes>;
  /** Default: protectedBotsStore().read(), read again on every call so edits apply at once. */
  readonly protectedBots?: () => Promise<ProtectedBots>;
  /** Default: boxStore({ server }), with its cache in ~/.grokbot/cache/box-store. */
  readonly boxStore?: BoxStore;
  /** Default: inboxStateStore() at ~/.grokbot/grokbot-cli-inbox-state.json. */
  readonly inboxState?: InboxStateStore;
  /** This computer's name, to match an inbox item's machine label. Default: os.hostname(). */
  readonly hostname?: string;
  /** Default: Date.now. */
  readonly now?: () => number;
  /** How often `inbox wait` looks at the inbox store. Default: 20 s. */
  readonly inboxPollMs?: number;
  /** The longest `inbox wait` the host allows, in seconds (MCP hosts kill long tool calls). Default: no cap. */
  readonly maxInboxWaitSeconds?: number;
}

/** Typed result of each catalog command. Renderers (CLI, MCP) format these; they never call RPCs. */
export interface CommandOutputs
  extends DispatchOutputs,
    WorkforceOutputs,
    GovernanceOutputs,
    InboxOutputs {}

export type CommandOutput<N extends CommandName> = CommandOutputs[N];

/**
 * What `CommandRunner.run` returns: the command's output, plus `inboxNotice` when the
 * command is not an inbox one and open items for this session or its jobs were waiting.
 */
export type CommandResult<N extends CommandName> = CommandOutput<N> & {
  readonly inboxNotice?: InboxNotice;
};

/** Runner progress outside the wait: the job is saved, and its message was accepted or queued. */
export interface DispatchedEvent {
  readonly type: "dispatched";
  readonly jobId: string;
  readonly agentId: string;
}

/** The job's message waits its turn: the bot is busy, `ahead` messages go out first. */
export interface QueuedEvent {
  readonly type: "queued";
  readonly jobId: string;
  readonly agentId: string;
  readonly ahead: number;
}

export type RunEvent = WaitEvent | DispatchedEvent | QueuedEvent;

export interface RunOptions {
  readonly signal?: AbortSignal;
  /**
   * Progress while ask/wait run (CLI prints it to stderr). `ask` emits `dispatched`
   * before it waits, so a caller that gives up later still holds the job id.
   */
  readonly onEvent?: (event: RunEvent) => void;
}

/** Executes catalog commands. Built once per process by `createCommandRunner`. */
export interface CommandRunner {
  run<N extends CommandName>(
    name: N,
    input: CommandInput<N>,
    options?: RunOptions,
  ): Promise<CommandResult<N>>;
}
