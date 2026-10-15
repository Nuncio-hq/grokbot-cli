import { Buffer } from "node:buffer";
import type { Agent } from "./agents.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  asJsonObject,
  type CardType,
  compareSeq,
  parseTranscriptEntry,
  readString,
  type Seq,
} from "./transcript.js";

/**
 * One open card from a bot's transcript, typed by kind so handlers and renderers never
 * re-read `message.widget`, `message.approval`, or `message.ask` themselves.
 */
export type GovernanceCard = {
  readonly entryId: string;
  readonly seq: Seq;
} & (
  | {
      readonly type: "widget";
      readonly prompt: string;
      readonly options: readonly string[];
    }
  | {
      readonly type: "auto-review-approval";
      readonly requestId: string;
      readonly summary: string;
      readonly command: string;
    }
  | {
      readonly type: "local-tool-permission";
      readonly requestId: string;
      readonly action: string;
      readonly target: string;
    }
  | { readonly type: "secret-request" | "connector" | "scm-connect" }
);

export type GovernanceCardType = GovernanceCard["type"];

export const ANSWERABLE: readonly GovernanceCardType[] = ["widget"];
export const APPROVABLE: readonly GovernanceCardType[] = [
  "auto-review-approval",
  "local-tool-permission",
];

/**
 * Body-level fields that close a card. The transcript parser keeps only `message`, but an
 * answered widget carries `respondedValue` and a dismissed one `widgetDismissed` or
 * `widgetSkipped` on the row body (live rows on Primary Test, 15 Oct).
 */
const CLOSED_BY_BODY: Partial<Record<CardType, (body: JsonObject) => boolean>> =
  {
    widget: (body) =>
      (typeof body.respondedValue === "string" && body.respondedValue !== "") ||
      body.widgetDismissed === true ||
      body.widgetSkipped === true,
    "secret-request": (body) => body.secretProvided === true,
  };

/** Open while its own status (or a direct child's, e.g. approval/ask) is missing or "pending". */
function statusIsOpen(message: JsonObject): boolean {
  const holders = [message, ...Object.values(message).map(asJsonObject)];
  const status = holders
    .map((holder) => (holder ? readString(holder, "status") : undefined))
    .find((value) => value !== undefined);
  return status === undefined || status === "pending";
}

function decodeBody(row: unknown): JsonObject {
  const b64 = readString(asJsonObject(row) ?? {}, "body");
  if (b64 === undefined) return {};
  try {
    const text = Buffer.from(b64, "base64").toString("utf8");
    return asJsonObject(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

function labels(widget: JsonObject): readonly string[] {
  const options = Array.isArray(widget.options) ? widget.options : [];
  return options
    .map((option) => readString(asJsonObject(option) ?? {}, "label"))
    .filter((label): label is string => label !== undefined);
}

type CardBody = GovernanceCard extends infer C
  ? C extends GovernanceCard
    ? Omit<C, "entryId" | "seq">
    : never
  : never;

function typed(type: CardType, message: JsonObject): CardBody {
  const child = (key: string) => asJsonObject(message[key]) ?? {};
  const text = (o: JsonObject, key: string) => readString(o, key) ?? "";
  switch (type) {
    case "widget": {
      const widget = child("widget");
      return { type, prompt: text(widget, "prompt"), options: labels(widget) };
    }
    case "auto-review-approval": {
      const a = child("approval");
      return {
        type,
        requestId: text(a, "requestId"),
        summary: readString(a, "summary") ?? readString(a, "reason") ?? "",
        command: text(a, "command"),
      };
    }
    case "local-tool-permission": {
      const ask = child("ask");
      return {
        type,
        requestId: text(ask, "requestId"),
        action: text(ask, "action"),
        target: text(ask, "target"),
      };
    }
    default:
      return { type };
  }
}

/** Open cards in raw ListGrokBotTranscriptEntries rows, oldest first. */
export function openCards(rows: unknown): GovernanceCard[] {
  const list = Array.isArray(rows) ? rows : [];
  const cards: GovernanceCard[] = [];
  for (const row of list) {
    const entry = parseTranscriptEntry(row);
    if (entry.kind !== "card" || !statusIsOpen(entry.message)) continue;
    if (CLOSED_BY_BODY[entry.cardType]?.(decodeBody(row))) continue;
    cards.push({
      entryId: entry.entryId,
      seq: entry.seq,
      ...typed(entry.cardType, entry.message),
    });
  }
  return cards.sort((a, b) => compareSeq(a.seq, b.seq));
}

/**
 * The one card a write command acts on: `cardId` (its entryId) when given, else the only
 * open card of an allowed kind. Throws not-found or ambiguous otherwise.
 */
export function selectCard(
  cards: readonly GovernanceCard[],
  kinds: readonly GovernanceCardType[],
  cardId: string | undefined,
  agent: Agent,
): GovernanceCard {
  const fits = cards.filter((card) => kinds.includes(card.type));
  const wanted = kinds.join(" or ");
  if (cardId !== undefined) {
    const match = fits.find((card) => card.entryId === cardId);
    if (match) return match;
    throw new GrokBotError(
      "not-found",
      `${agent.name} has no open ${wanted} card "${cardId}". Run grokbot approvals --agent "${agent.name}".`,
    );
  }
  const [only, ...rest] = fits;
  if (only !== undefined && rest.length === 0) return only;
  if (only === undefined) {
    throw new GrokBotError(
      "not-found",
      `${agent.name} has no open ${wanted} card.`,
    );
  }
  const ids = fits.map((card) => card.entryId).join(", ");
  throw new GrokBotError(
    "ambiguous",
    `${agent.name} has ${fits.length} open ${wanted} cards (${ids}). Pass --card <id>.`,
  );
}
