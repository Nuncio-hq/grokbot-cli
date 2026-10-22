import { GrokBotError } from "./contracts.js";
import { SERVER_METHOD_SAFETY } from "./method-safety-table.js";

/** Whether calling a method with each safety tag needs the owner's explicit OK. */
const REQUIRES_CONFIRMATION = {
  "read-only": false,
  writes: false,
  sensitive: true,
  destructive: true,
  "staff-only": true,
} as const;

export type MethodSafety = keyof typeof REQUIRES_CONFIRMATION;

/** Box Gateway methods Phases 01–03 use, at `<gatewayUrl>/api/<method>`. */
export const GATEWAY_METHOD_SAFETY = {
  listAgents: "read-only",
  getAgentWorkflows: "read-only",
  getMcpState: "read-only",
  // Reads the bot's own conversation text; changes nothing.
  searchConversation: "read-only",
  updateAgent: "writes",
  importAgentWorkflowText: "writes",
  runAgentWorkflowNow: "writes",
  // Runs any tool on any connected third-party MCP server with the owner's accounts.
  callMcpAppTool: "sensitive",
  deleteAgentWorkflow: "destructive",
} as const satisfies Readonly<Record<string, MethodSafety>>;

/** aiserver.v1.DashboardService methods, on the same backend as GrokBotService. */
export const DASHBOARD_METHOD_SAFETY = {
  // Mints a bearer key that lets anyone holding it start one webhook routine.
  CreateAutomationWebhookApiKey: "sensitive",
} as const satisfies Readonly<Record<string, MethodSafety>>;

/**
 * aiserver.v1.BackgroundComposerService methods (Cursor cloud agents), on the same backend.
 * Read-only reads only: GetBackgroundComposerArtifact is left out on purpose, it returns
 * bearer download URLs.
 */
export const BACKGROUND_COMPOSER_METHOD_SAFETY = {
  GetBackgroundComposerInfo: "read-only",
  GetBackgroundComposerConversation: "read-only",
  StreamBackgroundComposerUpdates: "read-only",
} as const satisfies Readonly<Record<string, MethodSafety>>;

const SERVER_TABLE: ReadonlyMap<string, MethodSafety> = new Map(
  Object.entries(SERVER_METHOD_SAFETY),
);
const GATEWAY_TABLE: ReadonlyMap<string, MethodSafety> = new Map(
  Object.entries(GATEWAY_METHOD_SAFETY),
);
const DASHBOARD_TABLE: ReadonlyMap<string, MethodSafety> = new Map(
  Object.entries(DASHBOARD_METHOD_SAFETY),
);
const BACKGROUND_COMPOSER_TABLE: ReadonlyMap<string, MethodSafety> = new Map(
  Object.entries(BACKGROUND_COMPOSER_METHOD_SAFETY),
);
const METHOD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/** Throws unless a GrokBotService method is safe to call (fails closed). */
export function assertMethodAllowed(method: string, confirmed: boolean): void {
  assertAllowed(SERVER_TABLE, method, confirmed);
}

/** Throws unless a Box Gateway method is safe to call (fails closed). */
export function assertGatewayMethodAllowed(
  method: string,
  confirmed: boolean,
): void {
  assertAllowed(GATEWAY_TABLE, method, confirmed);
}

/** Throws unless a DashboardService method is safe to call (fails closed). */
export function assertDashboardMethodAllowed(
  method: string,
  confirmed: boolean,
): void {
  assertAllowed(DASHBOARD_TABLE, method, confirmed);
}

/** Throws unless a BackgroundComposerService method is safe to call (fails closed). */
export function assertBackgroundComposerMethodAllowed(
  method: string,
  confirmed: boolean,
): void {
  assertAllowed(BACKGROUND_COMPOSER_TABLE, method, confirmed);
}

function assertAllowed(
  table: ReadonlyMap<string, MethodSafety>,
  method: string,
  confirmed: boolean,
): void {
  if (!METHOD_NAME.test(method)) {
    throw new GrokBotError(
      "safety",
      `${JSON.stringify(method)} is not a valid method name.`,
    );
  }
  if (confirmed) return;
  const safety = table.get(method);
  if (safety !== undefined && !REQUIRES_CONFIRMATION[safety]) return;
  const reason =
    safety === undefined
      ? "is not in the safety catalog"
      : `is tagged ${safety}`;
  throw new GrokBotError(
    "safety",
    `${method} ${reason}. Pass confirmed: true only after the owner approves.`,
  );
}

/**
 * Parses `docs/grokbot-tools-and-api.json` into `[method, safety]` pairs sorted
 * by name. The table generator and the drift test share it.
 */
export function parseMethodSafetyCatalog(
  catalog: unknown,
): [string, MethodSafety][] {
  const methods = isRecord(catalog) ? catalog.methods : undefined;
  if (!Array.isArray(methods)) {
    throw new Error("The catalog has no methods[] array.");
  }
  const table = new Map<string, MethodSafety>();
  for (const entry of methods) {
    const name = isRecord(entry) ? entry.name : undefined;
    const safety = isRecord(entry) ? entry.safety : undefined;
    if (typeof name !== "string" || !METHOD_NAME.test(name)) {
      throw new Error(
        `Catalog method name ${JSON.stringify(name)} is invalid.`,
      );
    }
    if (!isMethodSafety(safety)) {
      throw new Error(
        `Method ${name} has unknown safety tag ${JSON.stringify(safety)}.`,
      );
    }
    if (table.has(name)) {
      throw new Error(`Method ${name} appears twice in the catalog.`);
    }
    table.set(name, safety);
  }
  return [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function isMethodSafety(value: unknown): value is MethodSafety {
  return (
    typeof value === "string" && Object.hasOwn(REQUIRES_CONFIRMATION, value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
