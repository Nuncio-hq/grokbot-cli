import {
  describeChecked,
  describeInboxItem,
  describeWaited,
  type InboxCommandName,
  listNotes,
  oneLine,
  rowCells,
  WAIT_TIMED_OUT,
} from "grokbot-core";
import { type HumanRenderers, line, plain, table } from "./render-parts.js";

const sentNote = (
  out: {
    readonly jobId: string;
    readonly agent: { readonly name: string };
    readonly replyToId?: string;
    readonly queued: boolean;
  },
  what: string,
) =>
  `${what} sent to ${oneLine(out.agent.name)}${out.replyToId === undefined ? "" : " as a reply to its run"}${out.queued ? " (queued: it is busy, so it goes out once it is free)" : ""}. Its answer: grokbot wait ${out.jobId}\n`;

export const INBOX_RENDERERS: HumanRenderers<InboxCommandName> = {
  inbox: (out) => ({
    stdout:
      out.items.length === 0
        ? "No open inbox items.\n"
        : table(
            ["ID", "KIND", "SEVERITY", "AGE", "BOT", "TITLE"],
            out.items.map(rowCells),
          ),
    note: listNotes(out).map(line).join(""),
  }),
  "inbox-show": (out) => plain(describeInboxItem(out)),
  "inbox-fetch": ({ saved, out }) => ({
    stdout: saved.map((file) => line(file.path)).join(""),
    note: `Saved ${saved.length} ${saved.length === 1 ? "file" : "files"} to ${out}\n`,
  }),
  "inbox-reply": (out) => ({
    stdout: line(out.jobId),
    note: sentNote(out, out.action === "answer" ? "Answer" : "Reply"),
  }),
  "inbox-done": (out) => ({
    stdout: line(out.jobId),
    note: sentNote(out, `Closing note (${out.closedAs})`),
  }),
  "inbox-wait": (out) =>
    out.items.length === 0
      ? { stdout: "", note: line(WAIT_TIMED_OUT) }
      : plain(describeWaited(out.items)),
  // For a hook: the items go to stderr, where a blocked stop shows them to the agent.
  "inbox-check": (out) => ({
    stdout: "",
    note: out.items.length === 0 ? "" : describeChecked(out.items),
  }),
};
