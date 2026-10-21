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
      /** The message is still queued: it has not gone out yet. */
      readonly queued?: boolean;
    };

export interface TeamMember {
  readonly agent: Agent;
  readonly status: LiveStatus;
}

/** A message sent to one agent and followed until it settles or the wait times out. */
interface Asked {
  readonly jobId: string;
  readonly agent: Agent;
  readonly outcome: JobOutcome;
  /** What to do next: for `ask`, set only while the job is not settled; for `setup-bots`, always (see `next-step.ts`). */
  readonly next?: string;
}

/** Phase 01 command results. */
export interface DispatchOutputs {
  readonly agents: { readonly agents: readonly Agent[] };
  readonly team: { readonly members: readonly TeamMember[] };
  readonly ask: Asked;
  readonly "setup-bots": Asked;
  readonly reply: {
    readonly jobId: string;
    readonly agent: Agent;
    /** The transcript entry the message answered. */
    readonly replyToId: string;
    readonly outcome: JobOutcome;
    readonly next?: string;
  };
  readonly send: {
    readonly jobId: string;
    readonly agent: Agent;
    readonly sentMessageId: string;
    /** The bot was busy: the message waits its turn and goes out on a later send or wait. */
    readonly queued: boolean;
    /** What to do next: the message is sent, never settled (see `nextStep`). */
    readonly next?: string;
  };
  readonly wait: {
    readonly jobId: string;
    readonly agentId: string;
    /** The agent's name, recorded at send; absent on jobs saved before 16 Oct 2026. */
    readonly agentName?: string;
    readonly outcome: JobOutcome;
    readonly next?: string;
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
