/** The other bot on a bot-to-bot message. `id` is its agentId when the wire carries one. */
export interface AgentRef {
  readonly id: string | undefined;
  readonly name: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Live rows carry `toAgent {id, name, kind}` and `fromAgent {id, name}`; older
 * traces recorded a bare name. Anything else is no ref at all.
 */
export function parseAgentRef(value: unknown): AgentRef | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : { id: undefined, name: value };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const id = "id" in value ? nonEmpty(value.id) : undefined;
  const name = ("name" in value ? nonEmpty(value.name) : undefined) ?? id;
  return name === undefined ? undefined : { id, name };
}

/** By id when both refs carry one, else by name. */
export function isSameAgent(a: AgentRef, b: AgentRef): boolean {
  return a.id !== undefined && b.id !== undefined
    ? a.id === b.id
    : a.name === b.name;
}
