import type {
  DeliveredItem,
  InboxOutputs,
  InboxRow,
} from "./command-outputs-inbox.js";
import type { InboxPlace } from "./inbox-types.js";

/** Strips terminal control characters (an item is text a bot wrote) and joins lines. */
export const oneLine = (text: string): string =>
  text
    .replace(/\p{Cc}/gu, " ")
    .replace(/ {2,}/g, " ")
    .trim();

/** Keeps line breaks, drops every other control character. */
const block = (text: string): string => text.replace(/[^\P{Cc}\n]/gu, "");

/** `<1m`, `5m`, `3h`, `2d`. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export const YOUR_TURN_NOTE = "this computer, your turn";
/** The marks of an item whose `to.session` is the caller's own session, and of one whose is another's. */
const FOR_THIS_SESSION = "for this session";
const FOR_ANOTHER_SESSION = "for another session";

/** What the title column of one row says, markers included. */
export function rowTitle(row: InboxRow): string {
  switch (row.state) {
    case "needs-newer-grokbot":
      return "needs a newer grokbot (npm install -g grokbotagent-cli)";
    case "unreadable":
      return "unreadable item";
    case "pending":
      return "not synced yet";
    case "ok": {
      const marks = [
        ...(row.forThisSession ? [FOR_THIS_SESSION] : []),
        ...(row.toSession !== undefined && !row.forThisSession
          ? [FOR_ANOTHER_SESSION]
          : []),
        ...(row.yourTurnHere ? [YOUR_TURN_NOTE] : []),
        ...(row.handled ? [`handled here: ${row.handled.action}`] : []),
      ];
      const title = oneLine(row.title ?? "");
      return marks.length > 0 ? `${title} (${marks.join("; ")})` : title;
    }
  }
}

/** The cells of one row of the list: id, kind, severity, age, bot, title. */
export function rowCells(row: InboxRow): string[] {
  return [
    row.id,
    oneLine(String(row.kind)),
    row.severity ?? "-",
    formatAge(row.ageSeconds),
    oneLine(row.bot?.name ?? row.bot?.agentId.slice(0, 8) ?? "-"),
    rowTitle(row),
  ];
}

/** What the list leaves out or could not read, one line each. */
export function listNotes(out: InboxOutputs["inbox"]): string[] {
  const notes: string[] = [];
  if (out.scope.kind === "project") {
    notes.push(
      `Showing project ${oneLine(out.scope.project ?? "")}${out.scope.source === "route" ? " (this folder's route); --all shows every project" : ""}.`,
    );
  }
  if (out.hiddenHandled > 0) {
    notes.push(
      `${out.hiddenHandled} handled from this computer hidden (--include-handled shows them).`,
    );
  }
  if (out.hiddenExpired > 0) {
    notes.push(`${out.hiddenExpired} expired hidden.`);
  }
  if (out.elsewhere > 0) {
    notes.push(
      `${out.elsewhere} open in other projects (${out.projects.join(", ")}): --project <name> or --all.`,
    );
  }
  return notes;
}

const placeText = (place: InboxPlace): string =>
  [
    place.at,
    place.machine && `machine ${place.machine.label}`,
    place.agentId && `bot ${place.agentId}`,
    place.cloudAgentId,
    place.path,
    place.url,
    place.branch && `branch ${place.branch}`,
    place.commit && `commit ${place.commit}`,
    place.pr && `PR ${place.pr}`,
  ]
    .filter((part): part is string => Boolean(part))
    .map(oneLine)
    .join(" ");

/** The full card of an item as text, with its display fields. */
export function describeInboxItem(out: InboxOutputs["inbox-show"]): string {
  const { item, display } = out;
  if (item === undefined) {
    return `Inbox item ${out.id} was written by a newer grokbot (${oneLine(out.needsNewerGrokbot ?? "")}): npm install -g grokbotagent-cli.`;
  }
  const lines: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value !== undefined && value !== "")
      lines.push(`${label}: ${block(value)}`);
  };
  const list = (label: string, values: readonly string[] | undefined) => {
    if (values && values.length > 0) {
      lines.push(`${label}:`, ...values.map((v) => `  - ${oneLine(v)}`));
    }
  };
  lines.push(
    `${item.id} · ${item.kind} · ${item.severity} · ${oneLine(item.project)}`,
    oneLine(item.title),
  );
  const bot = display.bot?.name ?? display.bot?.agentId.slice(0, 8);
  const state = [
    out.folder,
    ...(display.expired ? ["expired"] : []),
    ...(display.handled
      ? [
          `handled here: ${display.handled.action} (job ${display.handled.jobId})`,
        ]
      : []),
  ];
  lines.push(
    `From ${oneLine(bot ?? "a bot")}, ${formatAge(display.ageSeconds)} ago · ${state.join(" · ")}`,
  );
  if (display.yourTurnHere)
    lines.push(
      `${YOUR_TURN_NOTE[0]?.toUpperCase()}${YOUR_TURN_NOTE.slice(1)}.`,
    );
  if (display.toSession !== undefined || display.toJob !== undefined) {
    const who = [
      display.toSession,
      display.toJob === undefined ? undefined : `job ${display.toJob}`,
    ]
      .filter((part): part is string => part !== undefined)
      .map(oneLine)
      .join(" · ");
    const whose = display.forThisSession
      ? "For this session"
      : display.toSession !== undefined
        ? "For another session"
        : "For";
    lines.push(`${whose}: ${who}`);
  }
  add("Start here", item.startHere);
  add("Done when", item.ask?.doneWhen);
  add("Verify", item.ask?.verify);
  add("Reply", item.ask?.reply);
  if (item.ask?.choices)
    add("Choices", item.ask.choices.map(oneLine).join(" | "));
  add("Blocking", item.ask?.blocking);
  add("Summary", item.details?.summary);
  add("Observed", item.details?.observed);
  add("Expected", item.details?.expected);
  list("Repro", item.details?.repro);
  list("Already checked", item.details?.alreadyChecked);
  if (item.details?.occurrences !== undefined) {
    add(
      "Seen",
      `${item.details.occurrences} times since ${item.details.firstSeenAt ?? "?"}`,
    );
  }
  const { work } = item;
  add("Work", work?.state);
  for (const step of work?.trail ?? []) {
    lines.push(
      `  trail: ${oneLine(step.did)} (${placeText(step)}${step.asOf ? `, ${step.asOf}` : ""})`,
    );
  }
  if (work?.latest) add("Latest", placeText(work.latest));
  if (work?.next) {
    const { next } = work;
    add(
      "Next",
      `${next.by}: ${oneLine(next.action ?? "")} at ${placeText(next)}`,
    );
    add("Command", next.command);
    if (next.needs && next.needs.length > 0)
      add("Needs", next.needs.join(", "));
  }
  if (display.machine) {
    add(
      "Machine",
      `${oneLine(display.machine.label)}${display.machine.isThisComputer ? " (this computer)" : ""}${display.machine.lastSeenAt ? `, last seen ${display.machine.lastSeenAt}` : ", not among your registered computers"}`,
    );
  }
  add("Local folder", display.localFolder);
  list(
    "Links",
    item.refs?.map((r) => `${oneLine(r.label)}: ${r.url}`),
  );
  list(
    `Files (grokbot inbox-fetch ${item.id})`,
    item.files?.map((f) => `${oneLine(f.name)} (${f.sizeBytes} bytes)`),
  );
  list(
    "Updates",
    item.updates?.map((u) => `${u.at}: ${oneLine(u.note)}`),
  );
  if (item.closed) {
    add(
      "Closed",
      `${item.closed.outcome} by ${oneLine(item.closed.by)} at ${item.closed.at}${item.closed.reason ? `: ${oneLine(item.closed.reason)}` : ""}${item.closed.ref ? ` ${item.closed.ref}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const clip = (text: string, max = 200): string => {
  const one = oneLine(text);
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Items handed to an agent unasked, short: per item its id, kind, severity, project, bot
 * and title, what it asks (done when, reply, choices) and the command that opens it. `lead`
 * says why they are shown.
 */
export function describeDelivered(
  items: readonly DeliveredItem[],
  lead: string,
): string {
  const lines = [lead];
  for (const item of items) {
    const bot = item.bot?.name ?? item.bot?.agentId.slice(0, 8) ?? "a bot";
    lines.push(
      `- ${item.id} · ${oneLine(item.kind)} · ${oneLine(item.severity)} · ${clip(item.project, 60)} · ${clip(bot, 40)} · ${clip(item.title, 100)}`,
    );
    const asks = [
      item.doneWhen === undefined
        ? undefined
        : `done when: ${clip(item.doneWhen)}`,
      item.reply === undefined ? undefined : `reply: ${clip(item.reply)}`,
      item.choices === undefined
        ? undefined
        : `choices: ${item.choices.map((c) => clip(c, 60)).join(" | ")}`,
    ].filter((part): part is string => part !== undefined);
    if (asks.length > 0) lines.push(`  asks: ${asks.join("; ")}`);
    lines.push(`  next: grokbot inbox-show ${item.id}`);
  }
  return `${lines.join("\n")}\n`;
}

const itemCount = (n: number) =>
  `${n} open inbox ${n === 1 ? "item" : "items"}`;

/** What `grokbot inbox wait` prints when it finds items. */
export const describeWaited = (items: readonly DeliveredItem[]): string =>
  describeDelivered(
    items,
    `${itemCount(items.length)} for this session or its jobs:`,
  );

/** What a hook shows the agent it is about to stop. */
export const describeChecked = (items: readonly DeliveredItem[]): string =>
  describeDelivered(
    items,
    `${itemCount(items.length)} for this session or its jobs, not shown to you yet. Read each before you stop:`,
  );

/** The notice that rides on another command's output. */
export const describeNotice = (items: readonly DeliveredItem[]): string =>
  describeDelivered(
    items,
    `Inbox: ${itemCount(items.length)} for this session or its jobs, new since you last looked:`,
  );

/** One line for an `inbox wait` that ran out of time. */
export const WAIT_TIMED_OUT =
  "Nothing yet for this session or its jobs; run grokbot inbox wait again.";
