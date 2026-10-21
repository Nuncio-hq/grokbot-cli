import type { BoxHandoff } from "./agent-status.js";
import type { Agent } from "./agents.js";
import type { GovernanceCard } from "./governance-cards.js";
import type { CloudAgentOutcome } from "./governance-cloud-agent-updates.js";
import type {
  CloudAgentInfo,
  CloudAgentMessage,
  CloudAgentSummary,
} from "./governance-cloud-agents.js";
import type {
  McpCallResult,
  McpServer,
  UserComputer,
} from "./governance-listings.js";

/**
 * The bot an approvals row names. Only what identifies it: a bot's `description` holds its
 * instructions and can run to kilobytes, which pushed `cards` past byte 5,000 of the JSON
 * and out of a truncated read (live 20 Oct).
 */
export type ApprovalAgent = Pick<Agent, "agentId" | "name" | "kind">;

/**
 * One agent's open cards. `cards` comes first so a truncated read of the JSON still sees
 * them. `awaiting` is the live.awaiting reason, null when not awaiting; `handoff` is a
 * pending box hand-off, null when there is none.
 */
export interface AgentCards {
  readonly cards: readonly GovernanceCard[];
  readonly agent: ApprovalAgent;
  readonly awaiting: string | null;
  readonly handoff: BoxHandoff | null;
}

/** The exact `cursor-agent worker start` invocation. Env names only, never values. */
export interface WorkerPlan {
  readonly command: readonly string[];
  readonly envNames: readonly string[];
}

/** Shared result of approve and deny. Not-dispatched calls throw instead. */
export interface ResolveOutput {
  readonly agent: Agent;
  readonly card: GovernanceCard;
  readonly verb: "approve" | "deny";
  /** "approved once", "approved always", or "denied". */
  readonly resolution: string;
  /** True when a local-tool allow also wrote ~/.grokbot/local-tool-approvals.json. */
  readonly wroteLocalApproval: boolean;
}

/** Phase 03 command results, one key per governance command. */
export interface GovernanceOutputs {
  readonly approvals: { readonly agents: readonly AgentCards[] };
  readonly answer: {
    readonly agent: Agent;
    readonly card: GovernanceCard;
    readonly dismissed: boolean;
    readonly value: string | undefined;
  };
  readonly approve: ResolveOutput;
  readonly deny: ResolveOutput;
  readonly computers: { readonly computers: readonly UserComputer[] };
  readonly "mcp-list": { readonly servers: readonly McpServer[] };
  readonly "mcp-call": {
    readonly server: string;
    readonly tool: string;
    readonly result: McpCallResult;
  };
  readonly vnc: {
    readonly window: number;
    readonly opened: boolean;
    /** Set only under --print-url. It is a credential; renderers warn on stderr. */
    readonly url: string | undefined;
  };
  readonly "worker-plan": {
    readonly plan: WorkerPlan;
    /** Labels of the computers already registered, so the owner sees what exists. */
    readonly registered: readonly string[];
  };
  readonly "worker-start": {
    readonly plan: WorkerPlan;
    /** The worker's exit code; null when a signal ended it. */
    readonly exitCode: number | null;
    /** How many times the FIFO handed out the token while the worker ran. */
    readonly tokenServes: number;
  };
  readonly "cloud-agents": {
    readonly cloudAgents: readonly CloudAgentSummary[];
    /** The account has more cloud agents than `--limit` listed; with --agent, ones past it may be missing. */
    readonly hasMore: boolean;
    /** The bot --agent filtered by; null when the list is the whole account's. */
    readonly launchedBy: {
      readonly agentId: string;
      readonly name: string;
    } | null;
  };
  readonly "cloud-agent": {
    readonly cloudAgent: CloudAgentInfo;
    /** The last `--messages` messages, oldest first. */
    readonly messages: readonly CloudAgentMessage[];
    /** Messages the conversation holds; null when none were read (`--messages 0`). */
    readonly messageCount: number | null;
    /** Set only under --wait: `done` once the agent stopped running, `needs-you` when it waits on the user, `pending` when the timeout came first. */
    readonly outcome?: CloudAgentOutcome;
  };
}
