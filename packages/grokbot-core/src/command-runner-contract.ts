import type { CommandInput, CommandName } from "./command-catalog.js";
import type { DispatchOutputs } from "./command-outputs-dispatch.js";
import type { GovernanceOutputs } from "./command-outputs-governance.js";
import type { WorkforceOutputs } from "./command-outputs-workforce.js";
import type { GatewayTransport, ServerTransport } from "./contracts.js";
import type { JobStore } from "./job-store.js";
import type { WebhookFirer } from "./routine-webhook.js";
import type { WebhookKeyStore } from "./routine-webhook-keys.js";
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
  /** Default: webhookKeyStore() in the macOS Keychain. */
  readonly webhookKeys?: WebhookKeyStore;
  /** Default: createWebhookFirer() over global fetch. */
  readonly fireWebhook?: WebhookFirer;
  /** Used when a command gets no `agent` input. Hosts pass process.env.GROKBOT_AGENT. */
  readonly defaultAgent?: string;
}

/** Typed result of each catalog command. Renderers (CLI, MCP) format these; they never call RPCs. */
export interface CommandOutputs
  extends DispatchOutputs,
    WorkforceOutputs,
    GovernanceOutputs {}

export type CommandOutput<N extends CommandName> = CommandOutputs[N];

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
  ): Promise<CommandOutput<N>>;
}
