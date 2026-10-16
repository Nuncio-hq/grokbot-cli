import {
  type DispatchCommandName,
  isActive,
  type JobOutcome,
  type TeamMember,
  type TranscriptEntry,
} from "grokbot-core";
import {
  type McpOverrides,
  plural,
  type ToolSummaries,
  waitHint,
} from "./mcp-tool-parts.js";

/**
 * Well under the ~300 s at which MCP hosts kill a tool call (Hermes), so ask and wait
 * return a still-running result with the job id first instead of dying mid-wait.
 */
const MCP_WAIT_TIMEOUT_SECONDS = 45;

/** What a finished result means, shared by every tool that waits on a job. */
const OUTCOMES =
  '"done" means the bot\'s run for this message ended, not that the task is verified; "ambiguous" means one run answered this message together with another, and the result holds every reply of that run';

export const DISPATCH_OVERRIDES: McpOverrides<DispatchCommandName> = {
  ask: {
    note: `Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set; a still-running result carries a job id, and grokbot_wait resumes it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  wait: {
    note: `Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set, to stay under MCP host time limits; a still-running result carries the job id, so call grokbot_wait again with it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  interrupt: { destructive: true },
};

function outcomeText(who: string, jobId: string, outcome: JobOutcome): string {
  switch (outcome.status) {
    case "done":
      return `${who} replied:\n${outcome.finalReply}`;
    case "ambiguous":
      return `${who} finished, but the reply is ambiguous: ${outcome.reason}. Every reply of that run, in order:\n${outcome.replyText}`;
    case "pending":
      return `${who} is still working (${outcome.reason}). Job ${jobId} is saved; ${waitHint(jobId)} to keep waiting.`;
    case "awaiting-approval":
      return `${who} is waiting for owner approval (${outcome.reason}). Approve it in the Grok Bot app, then ${waitHint(jobId)}.`;
  }
}

function memberText({ agent, status }: TeamMember): string {
  if (status.awaiting) {
    return `- ${agent.name}: awaiting owner (${status.awaiting.reason})`;
  }
  if (!isActive(status)) return `- ${agent.name}: idle`;
  const tool = status.activityTool ? ` (${status.activityTool})` : "";
  return `- ${agent.name}: running${tool}`;
}

function entryText(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user-message":
      return `user${entry.fromAgent ? ` (from ${entry.fromAgent.name})` : ""}: ${entry.content}`;
    case "assistant-message":
      return `assistant${entry.toAgent ? ` (to ${entry.toAgent.name})` : ""}: ${entry.content}`;
    // Attachment URLs may be signed links, so only the file name is shown.
    case "reply":
      return entry.reply.type === "text"
        ? `reply: ${entry.reply.content}`
        : `reply: ${`${entry.reply.fileName} [attachment]`.trim()}`;
    case "card":
      return `card ${entry.cardType}`;
    case "blob":
      return `blob ${entry.blobHash}`;
    case "unknown":
      return `unknown ${entry.entryKind}`;
  }
}

export const DISPATCH_SUMMARIES: ToolSummaries<DispatchCommandName> = {
  agents: ({ agents }) =>
    [
      `${plural(agents.length, "agent", "agents")}:`,
      ...agents.map((a) => `- ${a.name} (${a.kind}, ${a.agentId})`),
    ].join("\n"),
  team: ({ members }) =>
    [
      `${plural(members.length, "agent", "agents")}:`,
      ...members.map(memberText),
    ].join("\n"),
  ask: ({ jobId, agent, outcome }) => outcomeText(agent.name, jobId, outcome),
  send: ({ jobId, agent }) =>
    `Sent to ${agent.name}. Job ${jobId} is saved; ${waitHint(jobId)} for the reply.`,
  wait: ({ jobId, agentId, agentName, outcome }) =>
    outcomeText(agentName ?? `Agent ${agentId}`, jobId, outcome),
  tail: ({ agent, entries }) =>
    [
      `${agent.name}, last ${plural(entries.length, "entry", "entries")}:`,
      ...entries.map((e) => `#${e.seq} ${entryText(e)}`),
    ].join("\n"),
  interrupt: ({ agent, hadActiveRun }) =>
    hadActiveRun
      ? `Interrupted the active run on ${agent.name}.`
      : `${agent.name} had no active run.`,
};
