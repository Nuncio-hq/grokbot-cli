import type { DispatchCommandName, JobOutcome } from "grokbot-core";
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
    case "pending":
      return {
        stdout: `${jobId}\n`,
        note: `Not done yet: ${outcome.reason}\nResume with: grokbot wait ${jobId}\n`,
      };
    case "awaiting-approval": {
      const types = [...new Set(outcome.cards.map((c) => c.cardType))];
      const how = types
        .map((type) => CARD_ACTION[type] ?? "resolve it in the Grok Bot app")
        .filter((action, i, all) => all.indexOf(action) === i);
      const act =
        how.length > 0 ? how.join("; ") : "resolve it in the Grok Bot app";
      return {
        stdout:
          `Awaiting approval: ${outcome.reason}\n` +
          (types.length > 0 ? `Open cards: ${types.join(", ")}\n` : ""),
        note: `To continue, ${act}. Then resume with: grokbot wait ${jobId}\n`,
      };
    }
  }
}

/** How the owner resolves each card type from the CLI; types missing here are app-only. */
const CARD_ACTION: Readonly<Record<string, string>> = {
  widget: "answer it with: grokbot answer <value> (see grokbot approvals)",
  "auto-review-approval": "run grokbot approve --yes or grokbot deny --yes",
  "local-tool-permission": "run grokbot approve --yes or grokbot deny --yes",
};

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
  ask: ({ jobId, outcome }) => outcomeText(jobId, outcome),
  send: ({ jobId, agent }) => ({
    stdout: `${jobId}\n`,
    note: `Sent to ${agent.name}. Get the reply with: grokbot wait ${jobId}\n`,
  }),
  wait: ({ jobId, outcome }) => outcomeText(jobId, outcome),
  tail: ({ agent, entries }) =>
    plain(
      entries.length === 0
        ? `No transcript entries for ${agent.name}.\n`
        : `${entries.map(tailLine).join("\n")}\n`,
    ),
  interrupt: ({ agent, hadActiveRun }) =>
    plain(
      hadActiveRun
        ? `Interrupted the active run on ${agent.name}.\n`
        : `${agent.name} had no active run.\n`,
    ),
};
