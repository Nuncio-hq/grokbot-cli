import type {
  CommandName,
  CommandOutputs,
  LiveStatus,
  TranscriptEntry,
} from "grokbot-core";

/** Human-mode text of one command: `stdout` is the result, `note` a hint for stderr. */
export interface Text {
  readonly stdout: string;
  readonly note: string;
}

export type HumanRenderer<N extends CommandName> = (
  output: CommandOutputs[N],
) => Text;

/** One command group's human renderers, exhaustive over the group's names. */
export type HumanRenderers<Names extends CommandName> = {
  readonly [N in Names]: HumanRenderer<N>;
};

export const line = (text: string) =>
  text.endsWith("\n") ? text : `${text}\n`;
export const plain = (stdout: string): Text => ({ stdout, note: "" });

const TAIL_TEXT_LIMIT = 300;

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => (row[col] ?? "").length)),
  );
  const line = (row: readonly string[]) =>
    row
      .map((cell, col) =>
        col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0),
      )
      .join("  ");
  return `${all.map(line).join("\n")}\n`;
}

export const shortId = (agentId: string) => agentId.slice(0, 8);

/** First matching row wins; awaiting outranks activity, and activity a box hand-off, as in the Done Rule. */
const STATUS_LABELS: readonly ((s: LiveStatus) => string | undefined)[] = [
  (s) => (s.awaiting ? `awaiting ${s.awaiting.reason}`.trim() : undefined),
  (s) => (s.isComposing ? "composing" : undefined),
  (s) =>
    s.isRunning || s.isRetrying
      ? s.activityTool
        ? `running (${s.activityTool})`
        : "running"
      : undefined,
  (s) => (s.boxHandoff ? "awaiting box hand-off" : undefined),
  (s) => (s.hasRunningSubagents ? "subagents" : undefined),
];

export function statusLabel(status: LiveStatus): string {
  for (const label of STATUS_LABELS) {
    const text = label(status);
    if (text !== undefined) return text;
  }
  return "idle";
}

type EntryOf<K extends TranscriptEntry["kind"]> = Extract<
  TranscriptEntry,
  { kind: K }
>;

interface TailParts {
  readonly label: string;
  readonly text?: string;
}

const TAIL_PARTS: {
  readonly [K in TranscriptEntry["kind"]]: (entry: EntryOf<K>) => TailParts;
} = {
  "user-message": (e) => ({
    label: e.fromAgent ? `user from ${e.fromAgent.name}` : "user",
    text: e.content,
  }),
  "assistant-message": (e) => ({
    label: e.toAgent ? `assistant to ${e.toAgent.name}` : "assistant",
    text: e.content,
  }),
  // Attachment URLs may be signed links, so only the file name is shown.
  reply: (e) => ({
    label: "reply",
    text:
      e.reply.type === "text"
        ? e.reply.content
        : `${e.reply.fileName} [attachment]`.trim(),
  }),
  card: (e) => ({ label: "card", text: e.cardType }),
  blob: (e) => ({ label: "blob", text: e.blobHash }),
  unknown: (e) => ({ label: e.entryKind || "unknown" }),
};

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TAIL_TEXT_LIMIT
    ? `${flat.slice(0, TAIL_TEXT_LIMIT - 1)}…`
    : flat;
}

function partsOf<K extends TranscriptEntry["kind"]>(
  entry: EntryOf<K>,
): TailParts {
  const render: (entry: EntryOf<K>) => TailParts = TAIL_PARTS[entry.kind];
  return render(entry);
}

/** `[seq] kind: text`, one line, text cut to 300 characters. */
export function tailLine(entry: TranscriptEntry): string {
  const { label, text } = partsOf(entry);
  const body = text === undefined ? "" : oneLine(text);
  return body === ""
    ? `[${entry.seq}] ${label}`
    : `[${entry.seq}] ${label}: ${body}`;
}
