import {
  describeChecked,
  describeInboxItem,
  describeWaited,
  type InboxCommandName,
  listNotes,
  rowCells,
  WAIT_TIMED_OUT,
} from "grokbot-core";
import {
  type McpOverrides,
  plural,
  type ToolSummaries,
  waitHint,
} from "./mcp-tool-parts.js";

/** Well under the ~300 s at which MCP hosts kill a tool call; the same default `grokbot_wait` uses. */
export const MCP_INBOX_WAIT_DEFAULT = 45;
/** The longest `grokbot_inbox_wait` an MCP host is given, whatever timeout it asks for. */
export const MCP_INBOX_WAIT_MAX_SECONDS = 120;

export const INBOX_OVERRIDES: McpOverrides<InboxCommandName> = {
  inbox: {
    note: "Call it at the start of a conversation to see what the person's bots left for this assistant; each item's id goes to grokbot_inbox_show",
  },
  "inbox-show": {
    note: "Read an item before acting on it: follow its startHere, ask.doneWhen and ask.verify",
  },
  // Saving to a folder the model names is the CLI's; here files land under ~/.grokbot/inbox-files/<id>/.
  "inbox-fetch": {
    note: "Saves to ~/.grokbot/inbox-files/<id>/ and returns the paths",
    hiddenParams: ["out"],
  },
  "inbox-reply": {
    note: "Sends one message to the bot and returns at once; a decision item is the owner's to answer, so this refuses it",
  },
  "inbox-done": {
    note: "Sends the bot how the item ended and returns at once; a decision item is the owner's to answer, so this refuses it",
  },
  "inbox-wait": {
    note: `Waits ${MCP_INBOX_WAIT_DEFAULT} s unless timeout is set (at most ${MCP_INBOX_WAIT_MAX_SECONDS} s, to stay under MCP host time limits); an empty result means nothing yet, so call it again`,
    defaults: { timeout: `${MCP_INBOX_WAIT_DEFAULT}s` },
  },
  // Exit codes and stderr belong to the CLI: a hook runs the command, not a tool call.
  "inbox-check": { cliOnly: true },
};

const sent = (
  what: string,
  out: {
    readonly jobId: string;
    readonly agent: { readonly name: string };
    readonly queued: boolean;
  },
) =>
  `${what} sent to ${out.agent.name}${out.queued ? " (queued: the bot is busy)" : ""}. Job ${out.jobId}; ${waitHint(out.jobId)} for its answer.`;

export const INBOX_SUMMARIES: ToolSummaries<InboxCommandName> = {
  inbox: (out) =>
    [
      out.items.length === 0
        ? "No open inbox items."
        : `${plural(out.items.length, "open inbox item", "open inbox items")} (id, kind, severity, age, bot, title):`,
      ...out.items.map((row) => `- ${rowCells(row).join(" · ")}`),
      ...listNotes(out),
    ].join("\n"),
  "inbox-show": (out) => describeInboxItem(out),
  "inbox-fetch": ({ saved, out }) =>
    `Saved ${plural(saved.length, "file", "files")} to ${out}:\n${saved.map((f) => `- ${f.path}`).join("\n")}`,
  "inbox-reply": (out) =>
    sent(out.action === "answer" ? "Answer" : "Reply", out),
  "inbox-done": (out) => sent(`Closing note (${out.closedAs})`, out),
  "inbox-wait": (out) =>
    out.items.length === 0
      ? WAIT_TIMED_OUT.replace(
          "run grokbot inbox wait again",
          "call grokbot_inbox_wait again",
        )
      : describeWaited(out.items),
  "inbox-check": (out) => describeChecked(out.items),
};
