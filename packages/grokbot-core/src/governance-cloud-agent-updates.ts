import type { JsonObject } from "./contracts.js";
import {
  type CloudAgentStatus,
  type CloudAgentSummary,
  enumName,
  fromWorkflow,
  isCloudAgentActive,
  parseSnapshotFrame,
  readMs,
} from "./governance-cloud-agents.js";
import { asJsonObject, readString } from "./transcript.js";

/** An approval a cloud agent waits on (BackgroundComposerApprovalUpdate), as the update stream carries it. */
export interface CloudAgentApproval {
  readonly id: string;
  /** Lowercase kind (`mcp_tool`); "" when the server leaves it unset. */
  readonly kind: string;
  /** What the approval is for, as the server words it; "" when it sends none. */
  readonly headline: string;
  readonly operation: string;
  readonly target: string;
  /** Epoch ms the approval lapses; null when it has no expiry. */
  readonly expiresAtMs: number | null;
}

/** How `cloud-agent --wait` ended. */
export type CloudAgentOutcome =
  | { readonly status: "done" }
  | {
      /** The agent waits on the user (pending interaction or an approval); exit code 3. */
      readonly status: "needs-you";
      /** One line saying what it waits for. */
      readonly reason: string;
      /** The pending approval, when the update stream carried one. */
      readonly approval?: CloudAgentApproval;
    }
  | { readonly status: "pending"; readonly reason: string };

/** What a cloud agent is known to be doing, built from a snapshot row and update events. */
export interface CloudAgentWatch {
  readonly status: CloudAgentStatus;
  readonly needsYou: boolean;
  readonly approval?: CloudAgentApproval;
}

/** What one frame of the update stream says about one agent; a missing part says nothing. */
export interface CloudAgentChange {
  readonly status?: CloudAgentStatus;
  readonly needsYou?: boolean;
  /** An approval to track; null once none is pending. */
  readonly approval?: CloudAgentApproval | null;
}

export interface UpdateFrame {
  /** The cursor to resume from; the frame's own, undefined when it has none. */
  readonly cursor: string | undefined;
  /** Set when the frame says something about the agent it was parsed for. */
  readonly change: CloudAgentChange | undefined;
}

const UPDATE_KIND = "BACKGROUND_COMPOSER_UPDATE_KIND_";
const APPROVAL_STATE = "BACKGROUND_COMPOSER_APPROVAL_STATE_";
const APPROVAL_KIND = "BACKGROUND_COMPOSER_APPROVAL_KIND_";

/** Kinds the app's own stream consumer drops (main-app `JBn`): none of them changes status. */
const IGNORED_KINDS: Record<string, true> = {
  MEMBERSHIP_CHANGED: true,
  VISIBILITY_CHANGED: true,
  SUBSCRIPTIONS_CHANGED: true,
};

const REASON_LIMIT = 200;

export const watchOf = (agent: CloudAgentSummary): CloudAgentWatch => ({
  status: agent.status,
  needsYou: agent.needsYou,
});

/** The pending approval of an event; null when it holds none, or one already settled. */
function pendingApproval(raw: unknown): CloudAgentApproval | null {
  const o = asJsonObject(raw);
  if (!o || enumName(o.state, APPROVAL_STATE) !== "PENDING") return null;
  return {
    id: readString(o, "approvalId") ?? "",
    kind: (enumName(o.kind, APPROVAL_KIND) ?? "").toLowerCase(),
    headline: readString(o, "headline") ?? "",
    operation: readString(o, "operation") ?? "",
    target: readString(o, "target") ?? "",
    expiresAtMs: readMs(o, "expiresAtMs"),
  };
}

/**
 * An update event is the agent's whole state at that moment, and the server leaves false
 * and zero values out, so a missing `hasPendingInteraction` means false. Status is taken
 * the way the app takes it: only from an event with an update time, and never from an
 * approval change. A subtree rollup event aggregates a subtree, so its pending flag is
 * not read as this agent's own.
 */
function changeOf(event: JsonObject): CloudAgentChange | undefined {
  const kind = enumName(event.kind, UPDATE_KIND);
  if (kind !== undefined && Object.hasOwn(IGNORED_KINDS, kind))
    return undefined;
  const status =
    kind === "APPROVAL_CHANGED" || readMs(event, "updatedAtMs") === null
      ? undefined
      : fromWorkflow(
          enumName(event.workflowStatus, "CLOUD_AGENT_WORKFLOW_STATUS_"),
        );
  if (event.isSubtreeRollup === true) return status && { status };
  const pending = event.hasPendingInteraction === true;
  // An approval change is the word on the approval; any other event only clears it when
  // nothing is flagged as pending any more.
  const approval =
    pendingApproval(event.approval) ??
    (kind === "APPROVAL_CHANGED" || !pending ? null : undefined);
  return {
    ...(status && { status }),
    needsYou: pending,
    ...(approval !== undefined && { approval }),
  };
}

/** One frame of StreamBackgroundComposerUpdates, read for the agent `bcId`. */
export function parseUpdateFrame(frame: unknown, bcId: string): UpdateFrame {
  const root = asJsonObject(frame);
  const snapshot = parseSnapshotFrame(frame);
  if (snapshot) {
    const row = snapshot.agents.find((a) => a.bcId === bcId);
    return {
      cursor: readString(asJsonObject(root?.snapshot) ?? {}, "resumeCursor"),
      change: row && {
        status: row.status,
        needsYou: row.needsYou,
        ...(!row.needsYou && { approval: null }),
      },
    };
  }
  const event = asJsonObject(root?.event);
  const inner = asJsonObject(event?.event);
  if (inner) {
    return {
      cursor: readString(event ?? {}, "resumeCursor"),
      change:
        readString(inner, "bcId")?.trim() === bcId
          ? changeOf(inner)
          : undefined,
    };
  }
  return {
    cursor: readString(asJsonObject(root?.heartbeat) ?? {}, "resumeCursor"),
    change: undefined,
  };
}

export function applyChange(
  watch: CloudAgentWatch,
  change: CloudAgentChange,
): CloudAgentWatch {
  const approval =
    change.approval === undefined ? watch.approval : change.approval;
  return {
    status: change.status ?? watch.status,
    needsYou: change.needsYou ?? watch.needsYou,
    ...(approval && { approval }),
  };
}

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_LIMIT
    ? `${line.slice(0, REASON_LIMIT - 1)}…`
    : line;
};

/** One line saying what the agent waits for. */
export function needsYouReason(approval?: CloudAgentApproval): string {
  if (!approval) return "waiting for your input";
  const kind = approval.kind ? ` (${approval.kind})` : "";
  const what =
    oneLine(approval.headline) ||
    oneLine(`${approval.operation} ${approval.target}`);
  return `waiting for your approval${kind}${what ? `: ${what}` : ""}`;
}

/**
 * The outcome the watch has reached, or undefined while the agent is still working.
 * An error or an expiry ends it whatever else is flagged; otherwise a wait on the user
 * comes before a stop, because an idle agent that asked a question is not done.
 */
export function judgeWatch(
  watch: CloudAgentWatch,
): Exclude<CloudAgentOutcome, { status: "pending" }> | undefined {
  if (watch.status === "error" || watch.status === "expired") {
    return { status: "done" };
  }
  if (watch.needsYou || watch.approval) {
    return {
      status: "needs-you",
      reason: needsYouReason(watch.approval),
      ...(watch.approval && { approval: watch.approval }),
    };
  }
  return isCloudAgentActive(watch.status) ? undefined : { status: "done" };
}
