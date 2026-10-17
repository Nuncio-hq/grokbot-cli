import { parseAgentStatusesResponse } from "./agent-status.js";
import type { Agent } from "./agents.js";
import { OWNER_ONLY_NOTE } from "./card-descriptions.js";
import type {
  AgentCards,
  GovernanceOutputs,
  ResolveOutput,
} from "./command-outputs-governance.js";
import type { HandlerRun, RunnerContext } from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import {
  ANSWERABLE,
  APPROVABLE,
  type GovernanceCard,
  openCards,
  selectCard,
} from "./governance-cards.js";
import type { GovernanceDeps } from "./governance-deps.js";
import {
  recordLocalApproval,
  undoLocalApproval,
} from "./governance-local-approvals.js";
import {
  planResolution,
  type ResolveVerb,
  readAcceptance,
  readResolve,
} from "./governance-resolutions.js";
import { asJsonObject } from "./transcript.js";

/** Recent rows read per agent: enough to reach a card left open a few turns back. */
const CARD_WINDOW = 50;

async function cardsOf(
  ctx: RunnerContext,
  agent: Agent,
  signal?: AbortSignal,
): Promise<GovernanceCard[]> {
  const page = await ctx.server.call(
    "ListGrokBotTranscriptEntries",
    { agentId: agent.agentId, sessionId: "", limit: CARD_WINDOW },
    { signal },
  );
  return openCards(asJsonObject(page)?.entries);
}

export async function listApprovals(
  ctx: RunnerContext,
  agentFlag: string | undefined,
  signal?: AbortSignal,
): Promise<GovernanceOutputs["approvals"]> {
  const all = await ctx.fetchAgents(signal);
  const agents =
    agentFlag === undefined
      ? all.filter((agent) => agent.kind === "agent")
      : [await ctx.target(agentFlag, signal)];
  if (agents.length === 0) return { agents: [] };
  const statuses = parseAgentStatusesResponse(
    await ctx.server.call(
      "ListGrokBotAgentStatuses",
      { agentIds: agents.map((a) => a.agentId) },
      { signal },
    ),
  );
  const rows: AgentCards[] = [];
  for (const agent of agents) {
    const status = statuses.get(agent.agentId);
    rows.push({
      agent,
      awaiting: status?.awaiting?.reason ?? null,
      handoff: status?.boxHandoff ?? null,
      cards: await cardsOf(ctx, agent, signal),
    });
  }
  return {
    agents: rows.filter(
      (row) => row.cards.length > 0 || row.awaiting || row.handoff,
    ),
  };
}

export async function answerWidget(
  ctx: RunnerContext,
  input: {
    readonly value?: string;
    readonly agent?: string;
    readonly card?: string;
    readonly dismiss: boolean;
  },
  signal?: AbortSignal,
): Promise<GovernanceOutputs["answer"]> {
  if (input.dismiss === (input.value !== undefined)) {
    throw new GrokBotError(
      "not-found",
      input.dismiss
        ? "Pass either an answer or --dismiss, not both."
        : "Pass the answer, e.g. grokbot answer Blue, or --dismiss.",
    );
  }
  const agent = await ctx.target(input.agent, signal);
  const card = selectCard(
    await cardsOf(ctx, agent, signal),
    ANSWERABLE,
    input.card,
    agent,
  );
  const ids = { agentId: agent.agentId, entryId: card.entryId };
  const method = input.dismiss
    ? "DismissGrokBotWidget"
    : "RespondGrokBotWidget";
  const body = input.dismiss ? ids : { ...ids, value: input.value };
  const { accepted, refusal } = readAcceptance(
    await ctx.server.call(method, body, { signal }),
  );
  if (!accepted) {
    throw new GrokBotError(
      "protocol",
      `${method} was refused: ${refusal ?? "accepted is false"}`,
    );
  }
  return { agent, card, dismissed: input.dismiss, value: input.value };
}

export async function resolveCard(
  ctx: RunnerContext,
  deps: GovernanceDeps,
  verb: ResolveVerb,
  input: {
    readonly agent?: string;
    readonly card?: string;
    readonly always?: boolean;
  },
  run: HandlerRun,
): Promise<ResolveOutput> {
  const agent = await ctx.target(input.agent, run.signal);
  const card = selectCard(
    await cardsOf(ctx, agent, run.signal),
    APPROVABLE,
    input.card,
    agent,
  );
  // Phone calls and bot shares are auto-review cards whose description is owner-only.
  // Allowing one places a call or publishes a share. --yes and --always do not override
  // that: approve throws before the resolve RPC. Deny still resolves them as refused.
  if (
    verb === "approve" &&
    card.type === "auto-review-approval" &&
    card.ownerOnly
  ) {
    throw new GrokBotError("safety", `${card.summary}: ${OWNER_ONLY_NOTE}.`);
  }
  const always = input.always === true;
  const plan = planResolution(card, verb, always, agent.agentId);
  // The Mac daemon checks this file before running the command, so it lands first,
  // and comes back out if the server does not take the allow.
  const local = plan.localApproval
    ? await recordLocalApproval(deps.approvals, plan.localApproval)
    : undefined;
  try {
    const { dispatched, refusal } = readResolve(
      await ctx.server.call(plan.method, plan.body, {
        signal: run.signal,
        confirmed: run.confirmed,
      }),
    );
    if (!dispatched) {
      throw new GrokBotError(
        "protocol",
        `${plan.method} did not resolve card ${card.entryId}: ${refusal ?? "not dispatched"}`,
      );
    }
  } catch (error) {
    if (local) await undoLocalApproval(deps.approvals, local);
    throw error;
  }
  return {
    agent,
    card,
    verb,
    resolution: plan.resolution,
    wroteLocalApproval: plan.localApproval !== undefined,
  };
}
