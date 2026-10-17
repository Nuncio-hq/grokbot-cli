import {
  type CommandOutputs,
  describeBoxHandoff,
  type GovernanceCommandName,
  OWNER_ONLY_NOTE,
} from "grokbot-core";
import {
  type HumanRenderers,
  line,
  plain,
  shortId,
  table,
} from "./render-parts.js";

type Card = CommandOutputs["approvals"]["agents"][number]["cards"][number];

const DETAIL_LIMIT = 100;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_LIMIT
    ? `${flat.slice(0, DETAIL_LIMIT - 1)}…`
    : flat;
}

/** A bot awaits the owner but no card is in the rows read (governance-card-handlers.ts). */
const NO_CARD_NOTE =
  "no open card in the last 50 rows; check the bot in the GrokBot app";

/** A card grokbot leaves to the owner: what it asks, then who can answer it. */
const ownerOnly = (text: string) => `${clip(text)} (${OWNER_ONLY_NOTE})`;

/** One-line summary of what a card asks. */
export function cardDetail(card: Card): string {
  switch (card.type) {
    case "widget":
      return clip(
        card.options.length > 0
          ? `${card.prompt} [${card.options.join(" | ")}]`
          : card.prompt,
      );
    case "auto-review-approval":
      return card.ownerOnly
        ? ownerOnly(card.summary)
        : clip(
            [card.summary, card.command]
              .filter((part) => part !== "")
              .join(": "),
          );
    case "local-tool-permission":
      return clip(`${card.action}: ${card.target}`);
    default:
      return ownerOnly(card.summary);
  }
}

type AgentRow = CommandOutputs["approvals"]["agents"][number];

/** Table rows for one agent: a pending box hand-off, then its cards, else its awaiting reason. */
function approvalRows({ agent, awaiting, handoff, cards }: AgentRow) {
  const handoffRow = handoff
    ? [
        [
          agent.name,
          "box-handoff",
          handoff.requestId,
          ownerOnly(describeBoxHandoff(handoff)),
        ],
      ]
    : [];
  const cardRows = cards.map((card) => [
    agent.name,
    card.type,
    card.entryId,
    cardDetail(card),
  ]);
  const awaitingRow =
    cards.length === 0 && !handoff
      ? [
          [
            agent.name,
            "-",
            "-",
            `${clip(`awaiting: ${awaiting ?? ""}`.trim())} (${NO_CARD_NOTE})`,
          ],
        ]
      : [];
  return [...handoffRow, ...cardRows, ...awaitingRow];
}

const quote = (arg: string) =>
  /^[\w@%+=:,./$-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

const iso = (ms: string) =>
  ms === "0" ? "-" : new Date(Number(ms)).toISOString().slice(0, 16);

const CREDENTIAL_WARNING =
  "This link is a credential: anyone holding it can watch and control the desktop. Do not share or log it.\n";

export const GOVERNANCE_RENDERERS: HumanRenderers<GovernanceCommandName> = {
  approvals: ({ agents }) => {
    if (agents.length === 0) return plain("No open approval cards.\n");
    const rows = agents.flatMap(approvalRows);
    return plain(table(["AGENT", "CARD", "ID", "DETAIL"], rows));
  },
  answer: ({ agent, card, dismissed, value }) => ({
    stdout: dismissed ? "dismissed\n" : "accepted\n",
    note: dismissed
      ? `Dismissed widget ${card.entryId} on ${agent.name}.\n`
      : `Answered widget ${card.entryId} on ${agent.name} with ${JSON.stringify(value ?? "")}.\n`,
  }),
  approve: (out) => resolved(out),
  deny: (out) => resolved(out),
  computers: ({ computers }) =>
    plain(
      computers.length === 0
        ? "No computers registered.\n"
        : table(
            ["MACHINE", "LABEL", "KIND", "LAST SEEN (UTC)", "CAPABILITIES"],
            computers.map((c) => [
              c.machineId,
              c.label || "-",
              c.kind || "-",
              iso(c.lastSeenAtMs),
              c.capabilities.join(",") || "-",
            ]),
          ),
    ),
  "mcp-list": ({ servers }) =>
    plain(
      servers.length === 0
        ? "No MCP servers on the box.\n"
        : table(
            ["SERVER", "NAME", "TOOLS", "STATUS"],
            servers.map((s) => [
              s.serverIdentifier,
              s.name,
              s.disabledToolCount > 0
                ? `${s.toolCount} (+${s.disabledToolCount} off)`
                : String(s.toolCount),
              s.status || "-",
            ]),
          ),
    ),
  "mcp-call": ({ server, tool, result }) => ({
    stdout: line(result.text),
    note: result.isError ? `${server}/${tool} reported an error.\n` : "",
  }),
  vnc: ({ window, opened, url }) =>
    opened || url === undefined
      ? plain(`Opened desktop window ${window}.\n`)
      : { stdout: line(url), note: CREDENTIAL_WARNING },
  "worker-plan": ({ plan, registered }) => ({
    stdout: `${plan.command.map(quote).join(" ")}\nenv: ${plan.envNames.join(" ")}\n`,
    note:
      "Nothing started. $RUN_DIR is a fresh 0700 temp dir; token.fifo serves the token without writing it to disk.\n" +
      `Registered computers now: ${registered.join(", ") || "none"}.\n`,
  }),
  "worker-start": ({ exitCode, tokenServes }) =>
    plain(
      `Worker exited with code ${exitCode ?? "null (signal)"}. Served the token ${tokenServes} ${tokenServes === 1 ? "time" : "times"}.\n`,
    ),
};

function resolved(out: CommandOutputs["approve"]): {
  stdout: string;
  note: string;
} {
  const where = `${out.card.type} ${out.card.entryId} on ${out.agent.name} (${shortId(out.agent.agentId)})`;
  const local = out.wroteLocalApproval
    ? " Recorded it in ~/.grokbot/local-tool-approvals.json for the Mac daemon."
    : "";
  return { stdout: line(out.resolution), note: `Resolved ${where}.${local}\n` };
}
