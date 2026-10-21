import { GrokBotError, type JsonObject } from "./contracts.js";
import type { GovernanceCard } from "./governance-cards.js";
import { asJsonObject, readString } from "./transcript.js";

export type ResolveVerb = "approve" | "deny";

/**
 * The call that resolves one approval card. One typed table owns the enum strings and the
 * numeric local-tool codes, which the server validates strictly (catalog notes, 14 Oct:
 * short forms like "denied" and the code 0 both give HTTP 400).
 */
interface ResolvePlan {
  readonly method:
    | "ResolveGrokBotAutoReviewApproval"
    | "ResolveGrokBotLocalToolPermission";
  readonly body: JsonObject;
  /** Human label of the resolution sent, e.g. "approved once". */
  readonly resolution: string;
  /** Set for a local-tool allow: the entry the Mac daemon needs on disk first. */
  readonly localApproval?: {
    readonly id: string;
    readonly action: string;
    readonly target: string;
  };
}

type Choice = "once" | "always" | "deny";

const AUTO_REVIEW: Record<Choice, string> = {
  once: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED",
  always: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_ALWAYS",
  deny: "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_DENIED",
};
const LOCAL_TOOL: Record<Choice, number> = { once: 1, deny: 2, always: 3 };
const LABEL: Record<Choice, string> = {
  once: "approved once",
  always: "approved always",
  deny: "denied",
};

/** Builds the resolve call for a card. `agentId` comes from the resolved agent, never the card. */
export function planResolution(
  card: GovernanceCard,
  verb: ResolveVerb,
  always: boolean,
  agentId: string,
): ResolvePlan {
  const choice: Choice = verb === "deny" ? "deny" : always ? "always" : "once";
  const resolution = LABEL[choice];
  switch (card.type) {
    case "auto-review-approval":
      return {
        method: "ResolveGrokBotAutoReviewApproval",
        body: {
          agentId,
          requestId: card.requestId,
          resolution: AUTO_REVIEW[choice],
          approvalPlatform: "desktop",
        },
        resolution,
      };
    case "local-tool-permission": {
      const { requestId, action, target, entryId } = card;
      const plan: ResolvePlan = {
        method: "ResolveGrokBotLocalToolPermission",
        body: { agentId, entryId, requestId, resolution: LOCAL_TOOL[choice] },
        resolution,
      };
      return choice === "deny"
        ? plan
        : { ...plan, localApproval: { id: requestId, action, target } };
    }
    default:
      throw new GrokBotError(
        "not-found",
        `Card ${card.entryId} is a ${card.type} card; approve and deny resolve only auto-review-approval and local-tool-permission cards.`,
      );
  }
}

function refusalText(raw: unknown): string | undefined {
  const refusal = asJsonObject(asJsonObject(raw)?.refusal);
  if (!refusal) return undefined;
  const message = readString(refusal, "message") ?? "refused";
  const code = readString(refusal, "failureCode");
  return code === undefined ? message : `${message} (${code})`;
}

/** Reads a resolve `{ dispatched, refusal? }` response without throwing. */
export function readResolve(raw: unknown): {
  readonly dispatched: boolean;
  readonly refusal: string | undefined;
} {
  return {
    dispatched: (asJsonObject(raw)?.dispatched ?? false) === true,
    refusal: refusalText(raw),
  };
}

/** Reads a widget `{ accepted, refusal? }` response without throwing. */
export function readAcceptance(raw: unknown): {
  readonly accepted: boolean;
  readonly refusal: string | undefined;
} {
  return {
    accepted: (asJsonObject(raw)?.accepted ?? false) === true,
    refusal: refusalText(raw),
  };
}
