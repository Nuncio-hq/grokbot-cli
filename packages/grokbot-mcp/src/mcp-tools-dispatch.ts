import {
  type ConversationMatch,
  type DispatchCommandName,
  describeBoxHandoff,
  describeCard,
  describeReply,
  isActive,
  type JobOutcome,
  OWNER_ONLY_NOTE,
  SETUP_CHECK_PROJECT,
  type TeamMember,
  type TranscriptEntry,
} from "grokbot-core";
import {
  inboxWaitHint,
  type McpOverrides,
  plural,
  type ToolSummaries,
  waitHint,
} from "./mcp-tool-parts.js";

/**
 * Well under the ~300 s at which MCP hosts kill a tool call (Hermes), so ask and wait
 * return a still-running result with the job id first instead of dying mid-wait.
 */
export const MCP_WAIT_TIMEOUT_SECONDS = 45;

/** What a finished result means, shared by every tool that waits on a job. */
const OUTCOMES =
  '"done" means the bot\'s run for this message ended, not that the task is verified; "ambiguous" means one run answered this message together with another, and the result holds every reply of that run';

export const DISPATCH_OVERRIDES: McpOverrides<DispatchCommandName> = {
  ask: {
    note: `Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set; a still-running result carries a job id, and grokbot_wait resumes it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  "setup-bots": {
    note: `Sends the bot setup prompt to the account's primary Bot (or to agent), whatever the folder's route says. Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set; the bot usually needs longer, so a still-running result carries a job id, and grokbot_wait resumes it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  "update-bots": {
    note: `Asks the account's primary Bot (or agent), whatever the folder's route says, to install this computer's grokbot version on the cloud computer and save the grokbot-inbox skill again. Run it after grokbot changed here, or when a result carries an update notice. Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set; a still-running result carries a job id, and grokbot_wait resumes it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  reply: {
    note: `Replies to one message like Reply in the app: pass job (the bot's last message in that job, or the job's own message while the bot has written none) or to (an entryId from grokbot_tail) with agent. Pass quote to quote words of that message with the reply; they must appear in it, else the reply is refused. Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set; a still-running result carries a job id, and grokbot_wait resumes it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  wait: {
    note: `Waits ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set, to stay under MCP host time limits; a still-running result carries the job id, so call grokbot_wait again with it. ${OUTCOMES}`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
  search: {
    note: "Each match has a seq and an entryId (grokbot_reply takes the entryId as to); when older matches may exist the result gives the before value for the next page",
  },
  interrupt: { destructive: true },
};

function outcomeText(who: string, jobId: string, outcome: JobOutcome): string {
  const text = settledText(who, jobId, outcome);
  return outcome.status === "done" || outcome.status === "ambiguous"
    ? text
    : `${text} ${inboxWaitHint(jobId)}`;
}

function settledText(who: string, jobId: string, outcome: JobOutcome): string {
  switch (outcome.status) {
    case "done":
      return `${who} replied:\n${outcome.finalReply}`;
    case "ambiguous":
      return `${who} finished, but the reply is ambiguous: ${outcome.reason}. Every reply of that run, in order:\n${outcome.replyText}`;
    case "pending":
      return outcome.queued
        ? `${outcome.reason}. Job ${jobId} is saved; ${waitHint(jobId)} to send it and keep waiting.`
        : `${who} is still working (${outcome.reason}). Job ${jobId} is saved; ${waitHint(jobId)} to keep waiting.`;
    case "awaiting-approval":
      return awaitingText(who, jobId, outcome);
  }
}

/** What a `grokbot_setup_bots` caller does next, with the tools of this server. */
function setupText(who: string, jobId: string, outcome: JobOutcome): string {
  const settled = outcome.status === "done" || outcome.status === "ambiguous";
  const next = [
    settled ? "Next:" : "Next, once the reply is in:",
    "show the owner the project list from the reply and send their corrections with grokbot_reply",
    `${JSON.stringify({ job: jobId, text: "<corrections>" })}.`,
    `Wait for the "${SETUP_CHECK_PROJECT}" item the bot posts with grokbot_inbox_wait`,
    `${JSON.stringify({ job: [jobId.slice(0, 8)] })},`,
    `and close it with grokbot_inbox_done ${JSON.stringify({ id: "<item id>", outcome: "done" })}.`,
  ].join(" ");
  return `${settledText(who, jobId, outcome)} ${next}`;
}

const OWNER_ONLY = `${OWNER_ONLY_NOTE.charAt(0).toUpperCase()}${OWNER_ONLY_NOTE.slice(1)}`;

/** Names every open card and the box hand-off, and who can resolve them. */
function awaitingText(
  who: string,
  jobId: string,
  outcome: Extract<JobOutcome, { status: "awaiting-approval" }>,
): string {
  const cards = outcome.cards.map((c) => ({
    type: c.cardType,
    ...describeCard(c.cardType, c.message),
  }));
  const lines = [
    ...(outcome.handoff
      ? [
          `- box hand-off: ${describeBoxHandoff(outcome.handoff)} (${OWNER_ONLY_NOTE})`,
        ]
      : []),
    ...cards.map(
      (c) =>
        `- ${c.type}: ${c.text}${c.ownerOnly ? ` (${OWNER_ONLY_NOTE})` : ""}`,
    ),
  ];
  const act = cards.some((c) => !c.ownerOnly)
    ? "See grokbot_approvals and resolve the cards grokbot can once the owner says yes"
    : OWNER_ONLY;
  const list = lines.length > 0 ? `\n${lines.join("\n")}\n` : " ";
  return `${who} is waiting for owner approval (${outcome.reason}).${list}${act}, then ${waitHint(jobId)}.`;
}

function memberText({ agent, status }: TeamMember): string {
  if (status.awaiting) {
    return `- ${agent.name}: awaiting owner (${status.awaiting.reason})`;
  }
  if (status.boxHandoff && !status.isRunning) {
    return `- ${agent.name}: awaiting box hand-off (${describeBoxHandoff(status.boxHandoff)})`;
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
    // describeReply never shows a link: attachment URLs may be signed, and map and
    // product links stay in the structured output.
    case "reply":
      return `reply: ${describeReply(entry.reply)}`;
    case "card":
      return `card ${entry.cardType}`;
    case "blob":
      return `blob ${entry.blobHash}`;
    case "unknown":
      return `unknown ${entry.entryKind}`;
  }
}

/** `#seq [entryId] role time: snippet`, the time in UTC. */
function matchText({
  seq,
  entryId,
  role,
  timestampMs,
  snippet,
}: ConversationMatch): string {
  const when =
    timestampMs === undefined
      ? ""
      : ` ${new Date(timestampMs).toISOString().slice(0, 16)}Z`;
  return `#${seq} [${entryId}] ${role || "unknown"}${when}: ${snippet.replace(/\s+/g, " ").trim()}`;
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
  "setup-bots": ({ jobId, agent, outcome }) =>
    setupText(agent.name, jobId, outcome),
  "update-bots": ({ jobId, agent, outcome, version }) =>
    `Asked ${agent.name} to install grokbot ${version} on the cloud computer. ${outcomeText(agent.name, jobId, outcome)}`,
  reply: ({ jobId, agent, outcome }) => outcomeText(agent.name, jobId, outcome),
  send: ({ jobId, agent, queued }) =>
    `${
      queued
        ? `Queued for ${agent.name}: it is busy, so the message goes out once it is free; grokbot_edit with job ${jobId} changes it until then. Job ${jobId} is saved; ${waitHint(jobId)} to send it and get the reply.`
        : `Sent to ${agent.name}. Job ${jobId} is saved; ${waitHint(jobId)} for the reply.`
    } ${inboxWaitHint(jobId)}`,
  wait: ({ jobId, agentId, agentName, outcome }) =>
    outcomeText(agentName ?? `Agent ${agentId}`, jobId, outcome),
  edit: ({ jobId, agentId, agentName, queued }) =>
    `${
      queued
        ? `Edited. Still queued for ${agentName ?? `agent ${agentId}`}: it goes out once the bot is free; ${waitHint(jobId)} to send it and get the reply.`
        : `Edited and sent to ${agentName ?? `agent ${agentId}`}, which was free; ${waitHint(jobId)} for the reply.`
    } ${inboxWaitHint(jobId)}`,
  tail: ({ agent, entries }) =>
    [
      `${agent.name}, last ${plural(entries.length, "entry", "entries")}:`,
      ...entries.map((e) => `#${e.seq} [${e.entryId}] ${entryText(e)}`),
    ].join("\n"),
  search: ({ agent, query, matches, nextBeforeSeq }) =>
    matches.length === 0
      ? `No matches for ${JSON.stringify(query)} in ${agent.name}'s conversation.`
      : [
          `${agent.name}, ${plural(matches.length, "match", "matches")} for ${JSON.stringify(query)}, newest first:`,
          ...matches.map(matchText),
          ...(nextBeforeSeq === undefined
            ? []
            : [
                `There may be older matches: call grokbot_search with ${JSON.stringify({ query, before: nextBeforeSeq, agent: agent.agentId })}.`,
              ]),
        ].join("\n"),
  interrupt: ({ agent, hadActiveRun }) =>
    hadActiveRun
      ? `Interrupted the active run on ${agent.name}.`
      : `${agent.name} had no active run.`,
};
