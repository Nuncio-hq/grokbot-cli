import type { BoxHandoff } from "./agent-status.js";
import type { JsonObject } from "./contracts.js";
import { asJsonObject, type CardType, readString } from "./transcript.js";

/** What grokbot says about a card it must leave to the owner. */
export const OWNER_ONLY_NOTE =
  "only the owner can answer this in the GrokBot app";

/**
 * Card kinds grokbot resolves itself (answer, approve, deny). Every other kind waits on
 * the owner in the app: spending, credentials and connections stay owner actions. Within a
 * resolvable kind, `describeCard` still marks single cards owner-only (phone calls, bot
 * shares, rule-change widgets).
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
  "appearance-picker": () =>
    "The bot offers you a look for itself (shape and colour)",
  "email-offer": (m) => {
    const email = text(m, "email");
    const site = text(m, "site");
    return `The bot offers an email address of its own${email ? `: ${email}` : ""}${site ? ` (for ${site})` : ""}`;
  },
};

const EFFECT_LABEL: Readonly<Record<string, string>> = {
  allow: "Allow without asking",
  ask_first: "Ask first",
};

/** `Allow without asking: <text>`; an unknown effect shows just the quoted rule text. */
function ruleLine(effect: string, rule: string): string {
  const label = EFFECT_LABEL[effect];
  return `"${label ? `${label}: ` : ""}${rule}"`;
}

/**
 * A `widget` carrying `message.widget.ruleChange` (GrokBot app 0.75.0) proposes a change
 * to the owner's approval rules. The app saves the rule itself before it answers the
 * widget, so an answer from grokbot would only tell the bot the rule was saved. Absent
 * when the widget is an ordinary question.
 */
function ruleChangeText(widget: JsonObject): string | undefined {
  const change = asJsonObject(widget.ruleChange);
  if (!change) return undefined;
  const rule = ruleLine(text(change, "effect"), text(change, "text"));
  switch (text(change, "kind")) {
    case "add":
      return `The bot proposes a rule to add: ${rule}`;
    case "delete":
      return `The bot proposes to delete a rule: ${rule}`;
    case "update": {
      const old = text(change, "replaces");
      return `The bot proposes a rule update: ${rule}${old ? ` (replaces "${old}")` : ""}`;
    }
    default:
      return `The bot proposes a rule change: ${rule}`;
  }
}

/** A plain description of one card, from its transcript message. */
export function describeCard(
  cardType: CardType,
  message: JsonObject,
): CardDescription {
  switch (cardType) {
    case "widget": {
      const widget = child(message, "widget");
      const proposal = ruleChangeText(widget);
      return proposal === undefined
        ? { text: text(widget, "prompt") || "Question", ownerOnly: false }
        : { text: proposal, ownerOnly: true };
    }
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
