import { Buffer } from "node:buffer";
import { type AgentRef, parseAgentRef } from "./agent-ref.js";
import { GrokBotError, type JsonObject } from "./contracts.js";

/** int64 transcript position, kept as a decimal string and compared with BigInt. */
export type Seq = string & { readonly __brand: "Seq" };
/** int64 transcript generation; bumps when a conversation is cleared. */
export type Generation = string & { readonly __brand: "Generation" };

export const CARD_TYPES = [
  "widget",
  "secret-request",
  "auto-review-approval",
  "local-tool-permission",
  "connector",
  "scm-connect",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export type Reply =
  | { readonly type: "text"; readonly content: string }
  | {
      readonly type: "attachment";
      readonly url: string;
      readonly fileName: string;
    };

interface EntryBase {
  readonly seq: Seq;
  readonly updatedSeq: Seq;
  readonly entryId: string;
  readonly entryKind: string;
}

interface Stamped {
  readonly requestId: string | undefined;
  readonly timestampMs: number | undefined;
  /** Present and true while the bot is still writing the row. */
  readonly isStreaming?: boolean;
}

export type TranscriptEntry =
  | (EntryBase &
      Stamped & {
        readonly kind: "user-message";
        readonly content: string;
        readonly clientNonce: string | undefined;
        /** Set on another bot's message; undefined means the owner wrote it. */
        readonly fromAgent: AgentRef | undefined;
      })
  | (EntryBase &
      Stamped & {
        readonly kind: "assistant-message";
        readonly content: string;
        readonly toAgent: AgentRef | undefined;
      })
  | (EntryBase &
      Stamped & {
        readonly kind: "reply";
        readonly reply: Reply;
        /** The room member who wrote it; absent in a one-bot chat. */
        readonly author?: AgentRef;
      })
  | (EntryBase &
      Stamped & {
        readonly kind: "card";
        readonly cardType: CardType;
        readonly message: JsonObject;
        /** False once the owner resolved it: a status past "pending", or an answer on the row. */
        readonly open: boolean;
      })
  | (EntryBase & { readonly kind: "blob"; readonly blobHash: string })
  | (EntryBase & { readonly kind: "unknown"; readonly raw: unknown });

export type TranscriptEntryKind = TranscriptEntry["kind"];

export function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function readString(o: JsonObject, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(o: JsonObject, key: string): number | undefined {
  const v = o[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function parseInt64(value: unknown, what: string): string {
  if (value === undefined || value === null || value === "") return "0";
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value).toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new GrokBotError(
    "protocol",
    `${what} is not an int64: ${String(value)}`,
  );
}

/** Proto3 omits zero, so a missing seq parses as "0". */
export function parseSeq(value: unknown): Seq {
  return parseInt64(value, "seq") as Seq;
}

export function parseGeneration(value: unknown): Generation {
  return parseInt64(value, "generation") as Generation;
}

export function compareSeq(a: Seq, b: Seq): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function maxSeq(seqs: Iterable<Seq>, floor: Seq = parseSeq("0")): Seq {
  let top = floor;
  for (const s of seqs) if (compareSeq(s, top) > 0) top = s;
  return top;
}

function decodeBody(b64: string): JsonObject | undefined {
  try {
    return asJsonObject(
      JSON.parse(Buffer.from(b64, "base64").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

function stamped(body: JsonObject): Stamped {
  return {
    requestId: readString(body, "requestId"),
    timestampMs: readNumber(body, "timestampMs"),
    ...(body.isStreaming === true ? { isStreaming: true } : {}),
  };
}

type BodyParser = (
  body: JsonObject,
  base: EntryBase,
) => TranscriptEntry | undefined;

const ROLE_PARSERS: Record<string, BodyParser> = {
  user: (body, base) => ({
    ...base,
    ...stamped(body),
    kind: "user-message",
    content: readString(body, "content") ?? "",
    clientNonce: readString(body, "clientNonce"),
    fromAgent: parseAgentRef(body.fromAgent),
  }),
  assistant: (body, base) => ({
    ...base,
    ...stamped(body),
    kind: "assistant-message",
    content: readString(body, "content") ?? "",
    toAgent: parseAgentRef(body.toAgent),
  }),
};

function parseReply(message: JsonObject): Reply | undefined {
  const type = readString(message, "type");
  if (type === "text")
    return { type, content: readString(message, "content") ?? "" };
  if (type === "attachment") {
    return {
      type,
      url: readString(message, "url") ?? "",
      fileName: readString(message, "file_name") ?? "",
    };
  }
  return undefined;
}

function isCardType(type: string | undefined): type is CardType {
  return (CARD_TYPES as readonly (string | undefined)[]).includes(type);
}

/**
 * Row body fields that close a card. An answered widget gains `respondedValue`, a dismissed
 * one `widgetDismissed` (older rows `widgetSkipped`), a filled secret request `secretProvided`.
 */
const CLOSED_BY_BODY: Partial<Record<CardType, readonly string[]>> = {
  widget: ["respondedValue", "widgetDismissed", "widgetSkipped"],
  "secret-request": ["secretProvided"],
};

function isOpenCard(
  cardType: CardType,
  message: JsonObject,
  body: JsonObject,
): boolean {
  if (CLOSED_BY_BODY[cardType]?.some((key) => Boolean(body[key]))) return false;
  const holders = [message, ...Object.values(message).map(asJsonObject)];
  const status = holders
    .map((holder) => (holder ? readString(holder, "status") : undefined))
    .find((value) => value !== undefined);
  return status === undefined || status === "pending";
}

const BODY_PARSERS: Record<string, BodyParser> = {
  message: (body, base) =>
    ROLE_PARSERS[readString(body, "role") ?? ""]?.(body, base),
  "send-message": (body, base) => {
    const message = asJsonObject(body.message);
    if (!message) return undefined;
    const reply = parseReply(message);
    const author = parseAgentRef(body.author);
    if (reply) {
      return {
        ...base,
        ...stamped(body),
        kind: "reply",
        reply,
        ...(author && { author }),
      };
    }
    const cardType = readString(message, "type");
    if (!isCardType(cardType)) return undefined;
    const open = isOpenCard(cardType, message, body);
    return { ...base, ...stamped(body), kind: "card", cardType, message, open };
  },
};

/** Parses one wire row. Unrecognised kinds become `unknown`; only a bad seq throws. */
export function parseTranscriptEntry(raw: unknown): TranscriptEntry {
  const row = asJsonObject(raw);
  if (!row)
    throw new GrokBotError("protocol", "transcript entry is not an object");
  const base: EntryBase = {
    seq: parseSeq(row.seq),
    updatedSeq: parseSeq(row.updatedSeq ?? row.seq),
    entryId: readString(row, "entryId") ?? "",
    entryKind: readString(row, "entryKind") ?? "",
  };
  const bodyB64 = readString(row, "body");
  const blobHash = readString(row, "blobHash");
  if (bodyB64 === undefined && blobHash !== undefined) {
    return { ...base, kind: "blob", blobHash };
  }
  const body = bodyB64 === undefined ? undefined : decodeBody(bodyB64);
  if (!body) return { ...base, kind: "unknown", raw };
  return parseBody(body, base);
}

function parseBody(body: JsonObject, base: EntryBase): TranscriptEntry {
  const parsed = BODY_PARSERS[readString(body, "kind") ?? ""]?.(body, base);
  return parsed ?? { ...base, kind: "unknown", raw: body };
}

export type BlobEntry = Extract<TranscriptEntry, { kind: "blob" }>;
export type CardEntry = Extract<TranscriptEntry, { kind: "card" }>;

/** Parses the downloaded body of a blob row as if it had come inline. */
export function parseBlobBody(blob: BlobEntry, body: unknown): TranscriptEntry {
  const { seq, updatedSeq, entryId, entryKind } = blob;
  const base: EntryBase = { seq, updatedSeq, entryId, entryKind };
  const o = asJsonObject(body);
  return o ? parseBody(o, base) : { ...base, kind: "unknown", raw: body };
}

export function sortBySeq<T extends { readonly seq: Seq }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => compareSeq(a.seq, b.seq));
}

export function parseTranscriptEntries(rows: unknown): TranscriptEntry[] {
  return sortBySeq(Array.isArray(rows) ? rows.map(parseTranscriptEntry) : []);
}

export interface EntriesPage {
  readonly generation: Generation;
  readonly entries: TranscriptEntry[];
}

/** Parses a ListGrokBotTranscriptEntries response. */
export function parseEntriesResponse(raw: unknown): EntriesPage {
  const o = asJsonObject(raw);
  if (!o)
    throw new GrokBotError(
      "protocol",
      "ListGrokBotTranscriptEntries: not an object",
    );
  return {
    generation: parseGeneration(o.generation),
    entries: parseTranscriptEntries(o.entries),
  };
}
