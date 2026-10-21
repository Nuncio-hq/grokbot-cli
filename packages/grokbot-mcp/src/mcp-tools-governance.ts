import {
  type CommandOutputs,
  describeBoxHandoff,
  type GovernanceCommandName,
  OWNER_ONLY_NOTE,
} from "grokbot-core";
import {
  type McpOverrides,
  plural,
  type ToolSummaries,
} from "./mcp-tool-parts.js";
import { MCP_WAIT_TIMEOUT_SECONDS } from "./mcp-tools-dispatch.js";

type Card = CommandOutputs["approvals"]["agents"][number]["cards"][number];

export const GOVERNANCE_OVERRIDES: McpOverrides<GovernanceCommandName> = {
  answer: {
    note: "Pass value to answer the open widget, or dismiss: true to close it",
  },
  // The viewer URL is a credential, so it never lands in structuredContent.
  vnc: {
    note: "Opens the viewer on the host Mac",
    hiddenParams: ["print-url"],
  },
  // The worker inherits stdio, which is this server's JSON-RPC pipe.
  "worker-start": { cliOnly: true },
  "cloud-agent": {
    note: `With wait: true it follows the agent for ${MCP_WAIT_TIMEOUT_SECONDS} s unless timeout is set, to stay under MCP host time limits. A still-running result has outcome.status "pending", so call it again to keep waiting; outcome.status "needs-you" means the agent waits on the owner (outcome.reason says for what), so tell the owner before calling again`,
    defaults: { timeout: MCP_WAIT_TIMEOUT_SECONDS },
  },
};

function cardText(card: Card): string {
  switch (card.type) {
    case "widget":
      return `widget ${card.entryId}: ${card.prompt}${card.options.length > 0 ? ` [${card.options.join(" | ")}]` : ""}`;
    case "auto-review-approval":
      return card.ownerOnly
        ? `auto-review-approval ${card.entryId}: ${card.summary} (${OWNER_ONLY_NOTE})`
        : `auto-review-approval ${card.entryId}: ${card.summary}${card.command ? ` (${card.command})` : ""}`;
    case "local-tool-permission":
      return `local-tool-permission ${card.entryId}: ${card.action} ${card.target}`;
    default:
      return `${card.type} ${card.entryId}: ${card.summary} (${OWNER_ONLY_NOTE})`;
  }
}

/** What a `wait` outcome adds to the status line; nothing once the agent just stopped. */
function waitNote(outcome: CommandOutputs["cloud-agent"]["outcome"]): string {
  switch (outcome?.status) {
    case "pending":
      return ` (${outcome.reason}; call again to keep waiting)`;
    case "needs-you":
      return ` (${outcome.reason}; the owner has to act, then call again to keep waiting)`;
    default:
      return "";
  }
}

type AgentRow = CommandOutputs["approvals"]["agents"][number];

/** One agent's lines: a pending box hand-off, then its cards, else its awaiting reason. */
function agentLines({ agent, awaiting, handoff, cards }: AgentRow): string[] {
  const lines = [
    ...(handoff
      ? [
          `- ${agent.name}: box-handoff ${handoff.requestId}: ${describeBoxHandoff(handoff)} (${OWNER_ONLY_NOTE})`,
        ]
      : []),
    ...cards.map((card) => `- ${agent.name}: ${cardText(card)}`),
  ];
  if (lines.length > 0) return lines;
  const reason = awaiting ? ` ${awaiting}` : "";
  return [
    `- ${agent.name}: awaiting${reason} (no open card in the last 50 rows; check the bot in the GrokBot app)`,
  ];
}

const resolved = (out: CommandOutputs["approve"]) =>
  `${out.resolution}: ${out.card.type} ${out.card.entryId} on ${out.agent.name}.${out.wroteLocalApproval ? " Also recorded in ~/.grokbot/local-tool-approvals.json." : ""}`;

export const GOVERNANCE_SUMMARIES: ToolSummaries<GovernanceCommandName> = {
  approvals: ({ agents }) =>
    agents.length === 0
      ? "No open approval cards."
      : agents.flatMap(agentLines).join("\n"),
  answer: ({ agent, card, dismissed, value }) =>
    dismissed
      ? `Dismissed widget ${card.entryId} on ${agent.name}.`
      : `Accepted: answered widget ${card.entryId} on ${agent.name} with ${JSON.stringify(value ?? "")}.`,
  approve: resolved,
  deny: resolved,
  computers: ({ computers }) =>
    [
      `${plural(computers.length, "computer", "computers")}:`,
      ...computers.map(
        (c) =>
          `- ${c.label || c.machineId} (${c.kind || "unknown"}, ${c.machineId})`,
      ),
    ].join("\n"),
  "mcp-list": ({ servers }) =>
    [
      `${plural(servers.length, "MCP server", "MCP servers")}:`,
      ...servers.map(
        (s) =>
          `- ${s.serverIdentifier} (${s.name}): ${plural(s.toolCount, "tool", "tools")}, ${s.status || "unknown"}`,
      ),
    ].join("\n"),
  "mcp-call": ({ server, tool, result }) =>
    `${server}/${tool}${result.isError ? " reported an error" : ""}:\n${result.text}`,
  vnc: ({ window }) => `Opened desktop window ${window} on the host.`,
  "worker-plan": ({ plan, registered }) =>
    `Nothing started. Command:\n${plan.command.join(" ")}\nenv: ${plan.envNames.join(" ")}\nRegistered computers now: ${registered.join(", ") || "none"}.`,
  "worker-start": ({ exitCode, tokenServes }) =>
    `Worker exited with code ${exitCode ?? "null (signal)"}. Served the token ${plural(tokenServes, "time", "times")}.`,
  "cloud-agents": ({ cloudAgents, hasMore, launchedBy }) =>
    [
      `${plural(cloudAgents.length, "cloud agent", "cloud agents")}${launchedBy ? ` launched by ${launchedBy.name}` : ""}${hasMore ? " (more exist: raise limit)" : ""}:`,
      ...cloudAgents.map(
        (a) =>
          `- ${a.bcId} ${a.status}${a.needsYou ? " (needs you)" : ""}: ${a.name || "(unnamed)"}${a.repo ? ` (${a.repo}${a.branch ? ` ${a.branch}` : ""})` : ""}${a.prStatus ? ` PR ${a.prStatus}` : ""}`,
      ),
    ].join("\n"),
  "cloud-agent": ({ cloudAgent: a, messages, messageCount, outcome }) =>
    [
      `${a.name || "(unnamed)"} (${a.bcId}): ${a.status}${a.needsYou && outcome?.status !== "needs-you" ? " (needs you)" : ""}${waitNote(outcome)}`,
      ...(a.repo ? [`repo ${a.repo}${a.branch ? ` on ${a.branch}` : ""}`] : []),
      ...(a.prStatus ? [`PR ${a.prStatus} ${a.prUrl}`.trim()] : []),
      ...(messageCount === null
        ? []
        : [
            `${messages.length} of ${plural(messageCount, "message", "messages")}:`,
            ...messages.map((m) => `${m.role}: ${m.text.trim()}`),
          ]),
    ].join("\n"),
};
