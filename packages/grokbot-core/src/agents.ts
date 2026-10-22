import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";

/** Lowercase bot UUID, the id every other GrokBot RPC takes. */
export type AgentId = string & { readonly __brand: "AgentId" };

/** A starter prompt the app offers for a bot (0.75.0). */
export interface AgentSuggestion {
  /** What `DismissGrokBotAgentSuggestions` takes. */
  readonly id: string;
  /** sun, mail, calendar, search, chart, people, bell or sparkle; the app shows sparkle for any other value. */
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  /** The message the app sends when the user picks the suggestion. */
  readonly prompt: string;
}

interface AgentFields {
  readonly agentId: AgentId;
  /** Numeric server row id (int64 on the wire, so kept as a string). */
  readonly rowId: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly harness: string;
  /** Starter prompts the server offers for the bot; absent when it has none. */
  readonly suggestions?: readonly AgentSuggestion[];
}

export type Agent =
  | (AgentFields & { readonly kind: "agent" })
  | (AgentFields & {
      readonly kind: "room";
      readonly memberAgentIds: readonly AgentId[];
    });

const KIND_BY_WIRE = new Map<string, Agent["kind"]>([
  ["GROK_BOT_AGENT_KIND_AGENT", "agent"],
  ["GROK_BOT_AGENT_KIND_ROOM", "room"],
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(path: string, problem: string): never {
  throw new GrokBotError("protocol", `ListGrokBotAgents: ${path} ${problem}`);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAgentId(value: unknown, path: string): AgentId {
  if (typeof value !== "string" || !UUID.test(value))
    fail(path, "is not a UUID");
  return value.toLowerCase() as AgentId;
}

/** Proto3 JSON omits empty strings, so a missing field reads as "". */
function optionalString(value: unknown, path: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") fail(path, "is not a string");
  return value;
}

/**
 * Tolerant on purpose: every command reads this roster, and suggestions are an optional
 * extra behind an app gate, so an odd entry is dropped rather than failing the roster.
 */
function parseSuggestions(value: unknown): readonly AgentSuggestion[] {
  if (!Array.isArray(value)) return [];
  const text = (field: unknown) => (typeof field === "string" ? field : "");
  return value.flatMap((raw): AgentSuggestion[] =>
    isRecord(raw) && typeof raw.id === "string" && raw.id !== ""
      ? [
          {
            id: raw.id,
            icon: text(raw.icon),
            title: text(raw.title),
            detail: text(raw.detail),
            prompt: text(raw.prompt),
          },
        ]
      : [],
  );
}

function parseAgent(raw: unknown, path: string): Agent {
  if (!isRecord(raw)) fail(path, "is not an object");
  const kind =
    typeof raw.kind === "string" ? KIND_BY_WIRE.get(raw.kind) : undefined;
  if (kind === undefined)
    fail(`${path}.kind`, `${JSON.stringify(raw.kind)} is unknown`);
  if (typeof raw.id !== "string" || !/^\d+$/.test(raw.id)) {
    fail(`${path}.id`, "is not a numeric string");
  }
  const suggestions = parseSuggestions(raw.suggestions);
  const fields: AgentFields = {
    agentId: parseAgentId(raw.agentId, `${path}.agentId`),
    rowId: raw.id,
    name: optionalString(raw.name, `${path}.name`),
    title: optionalString(raw.title, `${path}.title`),
    description: optionalString(raw.description, `${path}.description`),
    harness: optionalString(raw.harness, `${path}.harness`),
    ...(suggestions.length > 0 && { suggestions }),
  };
  if (kind === "agent") return { kind, ...fields };
  const members = raw.memberAgentIds ?? [];
  if (!Array.isArray(members)) fail(`${path}.memberAgentIds`, "is not a list");
  return {
    kind,
    ...fields,
    memberAgentIds: members.map((id, i) =>
      parseAgentId(id, `${path}.memberAgentIds[${i}]`),
    ),
  };
}

/** Parses a ListGrokBotAgents response; throws GrokBotError("protocol") on a contract break. */
export function parseListAgentsResponse(raw: unknown): readonly Agent[] {
  if (!isRecord(raw)) fail("response", "is not an object");
  const rows = raw.agents ?? [];
  if (!Array.isArray(rows)) fail("agents", "is not a list");
  return rows.map((row, i) => parseAgent(row, `agents[${i}]`));
}

export async function listAgents(
  server: ServerTransport,
): Promise<readonly Agent[]> {
  return parseListAgentsResponse(await server.call("ListGrokBotAgents", {}));
}

const NO_AGENT_SELECTED =
  "No agent selected. Pass --agent <name|agentId>, set GROKBOT_AGENT, or run grokbot config route <agentId> in the project folder.";

/** The error when nothing selects an agent and the account has no primary Bot. */
export const noAgentError = () =>
  new GrokBotError(
    "not-found",
    "No agent selected and the account has no primary Bot. Pass --agent <name|agentId>, set GROKBOT_AGENT, or run grokbot config route <agentId> in the project folder.",
  );

/**
 * The agent query from the --agent flag, else GROKBOT_AGENT; undefined when neither is
 * set. The later steps (project route, the account's primary Bot) need I/O and live in
 * the runner context.
 */
export function pickAgentQuery(source: {
  readonly flag?: string;
  readonly env?: string;
}): string | undefined {
  return source.flag?.trim() || source.env?.trim() || undefined;
}

/** "Nhân Viên Đức" -> "nhan-vien-duc". */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface Query {
  readonly lower: string;
  readonly slug: string;
}

/** Tried in order; the first matcher with any hit decides. */
const MATCHERS: readonly ((query: Query, agent: Agent) => boolean)[] = [
  (q, agent) => agent.agentId === q.lower,
  (q, agent) => agent.name.trim().toLowerCase() === q.lower,
  (q, agent) => q.slug !== "" && slugify(agent.name) === q.slug,
  (q, agent) => q.lower.length >= 8 && agent.agentId.startsWith(q.lower),
];

/** Resolves a name, name slug, agentId, or agentId prefix (8+ chars) to exactly one agent. */
export function resolveAgent(query: string, agents: readonly Agent[]): Agent {
  const trimmed = query.trim();
  if (trimmed === "") throw new GrokBotError("not-found", NO_AGENT_SELECTED);
  const q: Query = { lower: trimmed.toLowerCase(), slug: slugify(trimmed) };
  for (const matches of MATCHERS) {
    const hits = agents.filter((agent) => matches(q, agent));
    const [only] = hits;
    if (only !== undefined && hits.length === 1) return only;
    if (hits.length > 1) {
      const list = hits.map((a) => `${a.name} (${a.agentId})`).join(", ");
      throw new GrokBotError(
        "ambiguous",
        `"${trimmed}" matches ${hits.length} agents: ${list}. Pass the full agentId.`,
      );
    }
  }
  const available =
    agents.length === 0
      ? "This account has no agents."
      : `Available agents: ${agents.map((a) => a.name).join(", ")}.`;
  throw new GrokBotError(
    "not-found",
    `No agent matches "${trimmed}". ${available}`,
  );
}
