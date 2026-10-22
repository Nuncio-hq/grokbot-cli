import {
  type ConversationMatch,
  type DispatchCommandName,
  describeCard,
  type JobOutcome,
  OWNER_ONLY_NOTE,
} from "grokbot-core";
import {
  type HumanRenderers,
  line,
  plain,
  shortId,
  statusLabel,
  type Text,
  table,
  tailLine,
} from "./render-parts.js";

function outcomeText(jobId: string, outcome: JobOutcome): Text {
  switch (outcome.status) {
    case "done":
      return plain(line(outcome.finalReply));
    case "ambiguous":
      return {
        stdout: line(outcome.replyText),
        note: `Ambiguous: ${outcome.reason}. stdout has every reply of that run, in order; check which one answers job ${jobId}.\n`,
      };
    case "pending":
      return {
        stdout: `${jobId}\n`,
        note: `Not done yet: ${outcome.reason}\nResume with: grokbot wait ${jobId}\n`,
      };
    case "awaiting-approval":
      return awaitingText(jobId, outcome);
  }
}

const unique = (items: readonly string[]) => [...new Set(items)];

/** Names every open card and the box hand-off, then says who can resolve each. */
function awaitingText(
  jobId: string,
  outcome: Extract<JobOutcome, { status: "awaiting-approval" }>,
): Text {
  const cards = outcome.cards.map((c) => ({
    type: c.cardType,
    ...describeCard(c.cardType, c.message),
  }));
  const listed = unique(cards.map((c) => `${c.type} (${c.text})`));
  const owners = unique([
    ...(outcome.handoff ? ["box hand-off"] : []),
    ...cards.filter((c) => c.ownerOnly).map((c) => c.type),
  ]);
  const how = unique(
    cards.flatMap((c) => (c.ownerOnly ? [] : (CARD_ACTION[c.type] ?? []))),
  );
  if (owners.length > 0 || how.length === 0) {
    const which = owners.length > 0 ? ` (${owners.join(", ")})` : "";
    how.push(`${OWNER_ONLY_NOTE}${which}`);
  }
  return {
    stdout:
      `Awaiting approval: ${outcome.reason}\n` +
      (listed.length > 0 ? `Open cards: ${listed.join(", ")}\n` : ""),
    note: `To continue, ${how.join("; ")}. Then resume with: grokbot wait ${jobId}\n`,
  };
}

/** How the owner resolves each card type from the CLI; types missing here are app-only. */
const CARD_ACTION: Readonly<Record<string, string>> = {
  widget: "answer it with: grokbot answer <value> (see grokbot approvals)",
  "auto-review-approval": "run grokbot approve --yes or grokbot deny --yes",
  "local-tool-permission": "run grokbot approve --yes or grokbot deny --yes",
};

/** The note with the next-step hint after it, when the job is not settled. */
const withNext = (text: Text, next: string | undefined): Text =>
  next === undefined ? text : { ...text, note: `${text.note}Next: ${next}\n` };

const ROLE_LABELS: Readonly<Record<string, string>> = {
  assistant: "bot",
  user: "you",
};

const two = (n: number) => String(n).padStart(2, "0");

/**
 * `[seq entryId] bot 2026-10-22 14:05: snippet`: the ids `--before` and `reply --to` take,
 * who said it, when (this computer's time zone), and the matching words on one line.
 */
function searchLine(match: ConversationMatch): string {
  const at =
    match.timestampMs === undefined ? undefined : new Date(match.timestampMs);
  const when =
    at === undefined
      ? ""
      : ` ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
  const who = ROLE_LABELS[match.role] ?? (match.role || "?");
  const snippet = match.snippet.replace(/\s+/g, " ").trim();
  return `[${match.seq} ${match.entryId}] ${who}${when}: ${snippet}`;
}

/** A shell word that stays one word whatever the text holds. */
const shellWord = (text: string) =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

export const DISPATCH_RENDERERS: HumanRenderers<DispatchCommandName> = {
  agents: ({ agents }) =>
    plain(
      agents.length === 0
        ? "No agents on this account.\n"
        : table(
            ["NAME", "ID", "KIND", "HARNESS"],
            agents.map((a) => [
              a.name,
              shortId(a.agentId),
              a.kind,
              a.harness || "-",
            ]),
          ),
    ),
  team: ({ members }) =>
    plain(
      members.length === 0
        ? "No agents on this account.\n"
        : table(
            ["NAME", "ID", "STATUS"],
            members.map((m) => [
              m.agent.name,
              shortId(m.agent.agentId),
              statusLabel(m.status),
            ]),
          ),
    ),
  ask: ({ jobId, outcome, next }) =>
    withNext(outcomeText(jobId, outcome), next),
  "setup-bots": ({ jobId, outcome, next }) =>
    withNext(outcomeText(jobId, outcome), next),
  "update-bots": ({ jobId, outcome, next }) =>
    withNext(outcomeText(jobId, outcome), next),
  reply: ({ jobId, outcome, next }) =>
    withNext(outcomeText(jobId, outcome), next),
  send: ({ jobId, agent, queued, next }) =>
    withNext(
      {
        stdout: `${jobId}\n`,
        note: queued
          ? `Queued for ${agent.name}: it is busy, so the message goes out once it is free (change it until then with: grokbot edit ${jobId} "<text>"). Send it and get the reply with: grokbot wait ${jobId}\n`
          : `Sent to ${agent.name}. Get the reply with: grokbot wait ${jobId}\n`,
      },
      next,
    ),
  wait: ({ jobId, outcome, next }) =>
    withNext(outcomeText(jobId, outcome), next),
  edit: ({ jobId, agentId, agentName, queued, next }) =>
    withNext(
      {
        stdout: `${jobId}\n`,
        note: queued
          ? `Edited. Still queued for ${agentName ?? `agent ${agentId}`}: it goes out once the bot is free. Send it and get the reply with: grokbot wait ${jobId}\n`
          : `Edited and sent to ${agentName ?? `agent ${agentId}`}, which was free. Get the reply with: grokbot wait ${jobId}\n`,
      },
      next,
    ),
  tail: ({ agent, entries }) =>
    plain(
      entries.length === 0
        ? `No transcript entries for ${agent.name}.\n`
        : `${entries.map(tailLine).join("\n")}\n`,
    ),
  search: ({ agent, query, matches, nextBeforeSeq }) =>
    matches.length === 0
      ? plain("No matches.\n")
      : {
          stdout: `${matches.map(searchLine).join("\n")}\n`,
          note:
            nextBeforeSeq === undefined
              ? ""
              : `More: grokbot search ${shellWord(query)} --before ${nextBeforeSeq} --agent ${shellWord(agent.name)}\n`,
        },
  interrupt: ({ agent, hadActiveRun }) =>
    plain(
      hadActiveRun
        ? `Interrupted the active run on ${agent.name}.\n`
        : `${agent.name} had no active run.\n`,
    ),
};
