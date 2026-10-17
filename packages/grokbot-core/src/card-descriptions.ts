import type { BoxHandoff } from "./agent-status.js";
import type { JsonObject } from "./contracts.js";
import { asJsonObject, type CardType, readString } from "./transcript.js";

/** What grokbot says about a card it must leave to the owner. */
export const OWNER_ONLY_NOTE =
  "only the owner can answer this in the GrokBot app";

/**
 * Card kinds grokbot resolves itself (answer, approve, deny). Every other kind waits on
 * the owner in the app: spending, credentials and connections stay owner actions.
 */
export const CLI_RESOLVABLE: readonly CardType[] = [
  "widget",
  "auto-review-approval",
  "local-tool-permission",
];

export interface CardDescription {
  /** One plain line saying what the card asks. */
  readonly text: string;
  /** True when grokbot leaves the card to the owner. */
  readonly ownerOnly: boolean;
}

const child = (o: JsonObject, key: string): JsonObject =>
  asJsonObject(o[key]) ?? {};
const text = (o: JsonObject, key: string): string =>
  readString(o, key)?.trim() ?? "";
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The bot-share payload; a command that is not JSON describes the share without a name. */
function parseShare(command: string): JsonObject {
  try {
    return asJsonObject(JSON.parse(command)) ?? {};
  } catch {
    return {};
  }
}

/** Just the host, so a path or query (which can carry a session id) is never shown. */
function hostOf(url: string): string {
  for (const candidate of [url, `https://${url}`]) {
    try {
      const { host } = new URL(candidate);
      if (host) return host;
    } catch {}
  }
  return url.split(/[/?#]/, 1)[0] ?? "";
}

/**
 * Phone calls and bot shares arrive as auto-review approvals (GrokBot app 0.71.2):
 * approval.summaryCopy {kind: "phone_call", params: {destination, request}} and
 * approval.surface "bot_share" with a JSON command {name, visibility}. The shipped
 * skill leaves both to the owner, so they are described as owner decisions.
 */
function autoReview(approval: JsonObject): CardDescription {
  const copy = child(approval, "summaryCopy");
  if (readString(copy, "kind") === "phone_call") {
    const params = child(copy, "params");
    const to = text(params, "destination");
    const request = text(params, "request");
    return {
      text: `Phone call to ${to || "a number"}${request ? `: ${request}` : ""}`,
      ownerOnly: true,
    };
  }
  if (readString(approval, "surface") === "bot_share") {
    const share = parseShare(text(approval, "command"));
    const name = text(share, "name");
    const visibility = text(share, "visibility");
    return {
      text: `Share this bot as a template${name ? ` "${name}"` : ""}${visibility ? ` (${visibility})` : ""}`,
      ownerOnly: true,
    };
  }
  const summary = text(approval, "summary") || text(approval, "reason");
  return { text: summary || "Approval needed", ownerOnly: false };
}

function credential(request: JsonObject): string {
  if (readString(request, "kind") === "brokered-login") {
    const sites = (Array.isArray(request.entries) ? request.entries : [])
      .map((entry) => text(asJsonObject(entry) ?? {}, "website"))
      .filter((site) => site !== "")
      .map(hostOf);
    const goal = text(request, "goal") || "1Password access request";
    return sites.length > 0 ? `${goal} (${sites.join(", ")})` : goal;
  }
  const site = text(request, "targetSite");
  const purpose = text(request, "purpose");
  return `Use a saved login${site ? ` for ${hostOf(site)}` : ""}${purpose ? `: ${purpose}` : ""}`;
}

const OWNER_TEXT: Partial<Record<CardType, (message: JsonObject) => string>> = {
  "secret-request": (m) => {
    const label = text(child(m, "secretRequest"), "label");
    return label ? `Secret requested: ${label}` : "Secret requested";
  },
  connector: (m) => {
    const name = text(m, "connector");
    return name ? `Connect ${name}` : "Connect an app";
  },
  "scm-connect": (m) => {
    const provider = text(m, "provider");
    return `Connect a code host${provider ? ` (${provider})` : ""}`;
  },
  "connector-grant": (m) => {
    const name = text(child(m, "ask"), "serverName");
    return `Allow ${name || "a connector"} for this turn`;
  },
  "user-form": (m) => {
    const form = child(m, "formRequest");
    const title = text(form, "title");
    const fields = Array.isArray(form.fields) ? form.fields.length : 0;
    return `Secure Form${title ? ` "${title}"` : ""} (${plural(fields, "field", "fields")})`;
  },
  "credential-request": (m) => credential(child(m, "credentialRequest")),
  "virtual-card-approval": (m) => {
    const title = text(child(m, "approval"), "title");
    return `Virtual card purchase${title ? `: ${title}` : ""}`;
  },
  "cookie-origin-approval": () => "Use the owner's existing browser logins",
  "meeting-join-consent": () =>
    "Check in with the other meeting participants before the bot joins",
  "mobile-tool-permission": (m) => {
    const permission = child(m, "permission");
    const tool = text(permission, "toolId");
    const phone = text(permission, "machineLabel");
    return `Permission on the owner's phone${tool ? `: ${tool}` : ""}${phone ? ` (${phone})` : ""}`;
  },
};

/** A plain description of one card, from its transcript message. */
export function describeCard(
  cardType: CardType,
  message: JsonObject,
): CardDescription {
  switch (cardType) {
    case "widget":
      return {
        text: text(child(message, "widget"), "prompt") || "Question",
        ownerOnly: false,
      };
    case "auto-review-approval":
      return autoReview(child(message, "approval"));
    case "local-tool-permission": {
      const ask = child(message, "ask");
      const parts = [text(ask, "action"), text(ask, "target")];
      return {
        text: parts.filter((p) => p !== "").join(": ") || "Mac permission",
        ownerOnly: false,
      };
    }
    default:
      return {
        text: OWNER_TEXT[cardType]?.(message) ?? cardType,
        ownerOnly: true,
      };
  }
}

/** What a pending box hand-off asks the owner to do. */
export function describeBoxHandoff(handoff: BoxHandoff): string {
  const instruction = handoff.instruction.trim();
  return `Take over the bot's computer${instruction ? `: ${instruction}` : ""}`;
}
