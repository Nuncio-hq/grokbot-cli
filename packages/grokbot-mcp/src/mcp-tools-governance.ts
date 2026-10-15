import type { CommandOutputs, GovernanceCommandName } from "grokbot-core";
import {
  type McpOverrides,
  plural,
  type ToolSummaries,
} from "./mcp-tool-parts.js";

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
};

function cardText(card: Card): string {
  switch (card.type) {
    case "widget":
      return `widget ${card.entryId}: ${card.prompt}${card.options.length > 0 ? ` [${card.options.join(" | ")}]` : ""}`;
    case "auto-review-approval":
      return `auto-review-approval ${card.entryId}: ${card.summary}${card.command ? ` (${card.command})` : ""}`;
    case "local-tool-permission":
      return `local-tool-permission ${card.entryId}: ${card.action} ${card.target}`;
    default:
      return `${card.type} ${card.entryId}`;
  }
}

const resolved = (out: CommandOutputs["approve"]) =>
  `${out.resolution}: ${out.card.type} ${out.card.entryId} on ${out.agent.name}.${out.wroteLocalApproval ? " Also recorded in ~/.grokbot/local-tool-approvals.json." : ""}`;

export const GOVERNANCE_SUMMARIES: ToolSummaries<GovernanceCommandName> = {
  approvals: ({ agents }) =>
    agents.length === 0
      ? "No open approval cards."
      : agents
          .flatMap(({ agent, awaiting, cards }) =>
            cards.length === 0
              ? [`- ${agent.name}: awaiting ${awaiting ?? ""}`.trimEnd()]
              : cards.map((card) => `- ${agent.name}: ${cardText(card)}`),
          )
          .join("\n"),
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
};
