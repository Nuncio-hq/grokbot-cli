import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/** What a cloud agent id looks like (`bc-…`), as the transcript and the app write it. */
export const CLOUD_AGENT_ID = /^bc-[A-Za-z0-9_-]{1,96}$/;

/** Where a Cursor cloud agent stands, as the app's list shows it. */
export type CloudAgentStatus =
  | "creating"
  | "running"
  | "finished"
  | "error"
  | "expired"
  | "unknown";

export type CloudAgentPrStatus = "open" | "draft" | "merged" | "closed";

/** One row of `cloud-agents`: what the account's list snapshot carries. */
export interface CloudAgentSummary {
  /** `bc-…`, the id every cloud agent command takes. */
  readonly bcId: string;
  readonly name: string;
  readonly status: CloudAgentStatus;
  /** Repository URL, "" when the agent has none. */
  readonly repo: string;
  /** Branch the agent works on, "" when it has none yet. */
  readonly branch: string;
  /** Null when the agent has opened no pull request. */
  readonly prStatus: CloudAgentPrStatus | null;
  /** "" when the agent has opened no pull request. */
  readonly prUrl: string;
  /** Epoch ms of the last update; null when the server sends none. */
  readonly updatedAtMs: number | null;
  readonly createdAtMs: number | null;
  /** Epoch ms of the last message in the agent's conversation; the list is ordered by it. */
  readonly lastActivityAtMs: number | null;
  /**
   * True when the agent waits on the user: the BackgroundComposer `has_pending_interaction`
   * flag. The server leaves a false flag out of its JSON, so absent reads as false.
   */
  readonly needsYou: boolean;
}

/** `cloud-agent`: the summary plus what GetBackgroundComposerInfo adds. */
export interface CloudAgentInfo extends CloudAgentSummary {
  /** Branch the agent's pull request targets, "" when unknown. */
  readonly baseBranch: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesChanged: number;
  readonly model: { readonly name: string; readonly maxMode: boolean } | null;
  /** Where the agent was started from, lowercase (`grok_bot`, `editor`, `slack`…); "" when unknown. */
  readonly source: string;
}

export interface CloudAgentMessage {
  readonly id: string;
  readonly role: "human" | "assistant";
  readonly text: string;
}

/** What a snapshot frame of StreamBackgroundComposerUpdates holds. */
export interface CloudAgentSnapshot {
  readonly agents: readonly CloudAgentSummary[];
  /** The account has more agents than the snapshot carried. */
  readonly hasMore: boolean;
}

/** Enums arrive as `<PREFIX>_<NAME>`; the app's own mapping switches on the bare name. */
export function enumName(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** The app's mapping of a cloud agent's workflow status (main-app `ZBn`). */
export function fromWorkflow(
  name: string | undefined,
): CloudAgentStatus | undefined {
  switch (name) {
    case "RUNNING":
    case "WAITING_FOR_BACKGROUND_WORK":
      return "running";
    case "ERROR":
      return "error";
    case "IDLE":
    case "ARCHIVED":
      return "finished";
    case "EXPIRED":
      return "expired";
    case "NOT_YET_STARTED":
      return "creating";
    default:
      return undefined;
  }
}

function fromComposer(name: string | undefined): CloudAgentStatus | undefined {
  switch (name) {
    case "RUNNING":
      return "running";
    case "FINISHED":
      return "finished";
    case "ERROR":
      return "error";
    case "CREATING":
      return "creating";
    case "EXPIRED":
      return "expired";
    default:
      return undefined;
  }
}

/** The workflow status first, as the app's update stream maps it; the plain status when it is unset. */
function statusOf(o: JsonObject): CloudAgentStatus {
  return (
    fromWorkflow(enumName(o.workflowStatus, "CLOUD_AGENT_WORKFLOW_STATUS_")) ??
    fromComposer(enumName(o.status, "BACKGROUND_COMPOSER_STATUS_")) ??
    "unknown"
  );
}

/** A status the agent is still working through: `--wait` polls while it holds. */
export function isCloudAgentActive(status: CloudAgentStatus): boolean {
  return status === "running" || status === "creating";
}

function prStatusOf(o: JsonObject): CloudAgentPrStatus | null {
  switch (enumName(o.prStatus, "PR_STATUS_")) {
    case "OPEN":
      return "open";
    case "DRAFT":
      return "draft";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return null;
  }
}

/** int64 fields arrive as numbers or decimal strings; 0 and absent both read as null. */
export function readMs(o: JsonObject, key: string): number | null {
  const count = readCount(o, key);
  return count > 0 ? count : null;
}

function readCount(o: JsonObject, key: string): number {
  const value = o[key];
  const count =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof count === "number" && Number.isFinite(count) && count > 0
    ? count
    : 0;
}

/**
 * `o` is a BackgroundComposer message. `pr` is the pull request the detail view lists for
 * it; the snapshot rows carry only the flattened status and url.
 */
function summaryOf(
  bcId: string,
  o: JsonObject,
  pr: JsonObject = {},
): CloudAgentSummary {
  return {
    bcId,
    name: readString(o, "name") ?? "",
    status: statusOf(o),
    repo: readString(o, "repoUrl") ?? "",
    branch: readString(o, "branchName") ?? "",
    prStatus:
      prStatusOf(o) ?? (o.isPrMerged === true ? "merged" : prStatusOf(pr)),
    prUrl: readString(o, "prUrl") || (readString(pr, "prUrl") ?? ""),
    updatedAtMs: readMs(o, "updatedAtMs"),
    createdAtMs: readMs(o, "createdAtMs"),
    lastActivityAtMs: readMs(o, "lastMessageActivityAtMs"),
    needsYou: o.hasPendingInteraction === true,
  };
}

/**
 * The agents of one frame of StreamBackgroundComposerUpdates, or undefined when the frame
 * is not the snapshot (a heartbeat or an update event). A row without an id is no agent.
 */
export function parseSnapshotFrame(
  frame: unknown,
): CloudAgentSnapshot | undefined {
  const snapshot = asJsonObject(asJsonObject(frame)?.snapshot);
  if (!snapshot) return undefined;
  const list = asJsonObject(snapshot.list) ?? {};
  const rows = Array.isArray(list.composers) ? list.composers : [];
  return {
    agents: rows.flatMap((row) => {
      const o = asJsonObject(row);
      const bcId = o && readString(o, "bcId");
      return o && bcId ? [summaryOf(bcId, o)] : [];
    }),
    hasMore: list.hasMore === true,
  };
}

/** Parses a GetBackgroundComposerInfo reply; throws GrokBotError("protocol") on a break. */
export function parseCloudAgentInfo(
  raw: unknown,
  bcId: string,
): CloudAgentInfo {
  const detail = asJsonObject(asJsonObject(raw)?.composer);
  const inner = asJsonObject(detail?.composer);
  if (!detail || !inner) {
    throw new GrokBotError(
      "protocol",
      "GetBackgroundComposerInfo: the reply has no composer.",
    );
  }
  const model = asJsonObject(inner.modelDetails ?? detail.modelDetails);
  const modelName = model && readString(model, "modelName");
  return {
    ...summaryOf(
      readString(inner, "bcId") || bcId,
      inner,
      asJsonObject(Array.isArray(detail.prs) ? detail.prs[0] : undefined),
    ),
    baseBranch: readString(detail, "baseBranch") ?? "",
    linesAdded: readCount(inner, "linesAdded"),
    linesRemoved: readCount(inner, "linesRemoved"),
    filesChanged: readCount(inner, "filesChanged"),
    model: modelName
      ? { name: modelName, maxMode: model.maxMode === true }
      : null,
    source: (
      enumName(inner.source, "BACKGROUND_COMPOSER_SOURCE_") ?? ""
    ).toLowerCase(),
  };
}

/** The bubble id suffix of a message the agent sent to the user on purpose. */
const SENT_BUBBLE = ":send-message";

/**
 * Parses a GetBackgroundComposerConversation reply into what a person would read, in
 * order, with the app's own selection: a human message counts unless it steers a running
 * turn or is simulated (a subscription wake-up); an AI bubble counts when it holds no
 * thinking and no tool results, or is the agent's send-message. Blank text is dropped.
 */
export function parseConversation(raw: unknown): readonly CloudAgentMessage[] {
  const root = asJsonObject(raw);
  if (!root) {
    throw new GrokBotError(
      "protocol",
      "GetBackgroundComposerConversation: not an object",
    );
  }
  const rows = Array.isArray(root.conversation) ? root.conversation : [];
  return rows.flatMap((row): CloudAgentMessage[] => {
    const o = asJsonObject(row);
    const text = o && readString(o, "text");
    if (!o || !text || text.trim() === "") return [];
    const id = readString(o, "bubbleId") ?? "";
    switch (enumName(o.type, "MESSAGE_TYPE_")) {
      case "HUMAN":
        return o.turnSteer === true || o.isSimulatedMsg === true
          ? []
          : [{ id, role: "human", text }];
      case "AI": {
        const plain =
          o.thinking === undefined &&
          (!Array.isArray(o.toolResults) || o.toolResults.length === 0);
        return plain || id.endsWith(SENT_BUBBLE)
          ? [{ id, role: "assistant", text }]
          : [];
      }
      default:
        return [];
    }
  });
}

/**
 * True when `agentId` holds a launch watch on the agent: the record a bot leaves when it
 * starts one. A reply or plain watch on someone else's agent does not count.
 */
export function isLaunchedBy(watchers: unknown, agentId: string): boolean {
  const rows = asJsonObject(watchers)?.watchers;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const w = asJsonObject(row);
    return (
      w?.agentId === agentId &&
      enumName(w.kind, "GROK_BOT_CLOUD_AGENT_WATCH_KIND_") === "LAUNCH"
    );
  });
}
