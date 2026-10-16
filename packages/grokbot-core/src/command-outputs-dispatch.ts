import type { LiveStatus } from "./agent-status.js";
import type { Agent } from "./agents.js";
import type { TranscriptEntry } from "./transcript.js";
import type { WaitResult } from "./wait-for-done.js";

/** Where a dispatched job stands when a command returns. */
export type JobOutcome =
  | WaitResult
  | {
      /** The wait timed out; the job is saved and `grokbot wait <jobId>` resumes it. */
      readonly status: "pending";
      readonly reason: string;
    };

export interface TeamMember {
  readonly agent: Agent;
  readonly status: LiveStatus;
}

/** Phase 01 command results. */
export interface DispatchOutputs {
  readonly agents: { readonly agents: readonly Agent[] };
  readonly team: { readonly members: readonly TeamMember[] };
  readonly ask: {
    readonly jobId: string;
    readonly agent: Agent;
    readonly outcome: JobOutcome;
  };
  readonly send: {
    readonly jobId: string;
    readonly agent: Agent;
    readonly sentMessageId: string;
  };
  readonly wait: {
    readonly jobId: string;
    readonly agentId: string;
    /** The agent's name, recorded at send; absent on jobs saved before 16 Oct 2026. */
    readonly agentName?: string;
    readonly outcome: JobOutcome;
  };
  readonly tail: {
    readonly agent: Agent;
    readonly entries: readonly TranscriptEntry[];
  };
  readonly interrupt: {
    readonly agent: Agent;
    readonly hadActiveRun: boolean;
  };
}
