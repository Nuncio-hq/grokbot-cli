import type { Agent } from "./agents.js";
import type { GovernanceCard } from "./governance-cards.js";
import type {
  McpCallResult,
  McpServer,
  UserComputer,
} from "./governance-listings.js";

/** One agent's open cards. `awaiting` is the live.awaiting reason, null when not awaiting. */
export interface AgentCards {
  readonly agent: Agent;
  readonly awaiting: string | null;
  readonly cards: readonly GovernanceCard[];
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
}
