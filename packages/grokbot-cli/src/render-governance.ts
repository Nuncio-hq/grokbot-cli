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
function cardDetail(card: Card): string {
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

const isoMs = (ms: number | null) =>
  ms === null ? "-" : new Date(ms).toISOString().slice(0, 16);

/** `cloud-agent` header: labelled lines, blank values left out. */
function agentFacts(out: CommandOutputs["cloud-agent"]): string {
  const a = out.cloudAgent;
  const pr = [a.prStatus, a.prUrl].filter(Boolean).join(" ");
  const changes =
    a.filesChanged > 0 || a.linesAdded > 0 || a.linesRemoved > 0
      ? `${a.filesChanged} files, +${a.linesAdded} -${a.linesRemoved}`
      : "";
  const model = a.model
    ? `${a.model.name}${a.model.maxMode ? " (max mode)" : ""}`
    : "";
  const facts: readonly (readonly [string, string])[] = [
    ["Agent", `${a.name || "(unnamed)"} (${a.bcId})`],
    ["Status", a.status],
    ["Waiting", a.needsYou ? "for you" : ""],
    ["Repo", a.repo],
    ["Branch", a.baseBranch ? `${a.branch} -> ${a.baseBranch}` : a.branch],
    ["PR", pr],
    ["Changes", changes],
    ["Model", model],
    ["Source", a.source],
    ["Updated", a.updatedAtMs === null ? "" : `${isoMs(a.updatedAtMs)} UTC`],
  ];
  return facts
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `${`${label}:`.padEnd(9)}${value}\n`)
    .join("");
}

/** What stderr says about how `--wait` ended; nothing when the agent simply stopped. */
function outcomeNote(
  outcome: CommandOutputs["cloud-agent"]["outcome"],
): string {
  switch (outcome?.status) {
    case "pending":
      return `Gave up waiting: ${outcome.reason}. Run it again with --wait to keep waiting.\n`;
    case "needs-you":
      return `Needs you: ${outcome.reason}. Run it again with --wait once you have answered.\n`;
    default:
      return "";
  }
}

/** The messages the command read, oldest first, each with its role; blank line between. */
function conversationText(out: CommandOutputs["cloud-agent"]): string {
  if (out.messageCount === null) return "";
  if (out.messages.length === 0) return "\nNo messages yet.\n";
  const shown =
    out.messages.length < out.messageCount
      ? `Last ${out.messages.length} of ${out.messageCount} messages:`
      : `${out.messageCount} ${out.messageCount === 1 ? "message" : "messages"}:`;
  const body = out.messages
    .map((m) => `[${m.role}]\n${m.text.trim()}\n`)
    .join("\n");
  return `\n${shown}\n\n${body}`;
}

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
  "cloud-agents": ({ cloudAgents, hasMore, launchedBy }) => {
    const none = launchedBy
      ? `No cloud agents launched by ${launchedBy.name} in the latest ones.\n`
      : "No cloud agents on this account.\n";
    const more = hasMore
      ? "More cloud agents exist than were listed; raise --limit to see them.\n"
      : "";
    return {
      stdout:
        cloudAgents.length === 0
          ? none
          : table(
              ["ID", "NAME", "STATUS", "REPO", "BRANCH", "PR", "UPDATED (UTC)"],
              cloudAgents.map((a) => [
                a.bcId,
                clip(a.name) || "-",
                a.needsYou ? `${a.status}, needs you` : a.status,
                a.repo || "-",
                a.branch || "-",
                a.prStatus ?? "-",
                isoMs(a.updatedAtMs),
              ]),
            ),
      note: more,
    };
  },
  "cloud-agent": (out) => ({
    stdout: `${agentFacts(out)}${conversationText(out)}`,
    note: outcomeNote(out.outcome),
  }),
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
