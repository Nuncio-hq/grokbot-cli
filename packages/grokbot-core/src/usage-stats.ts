import { parseListAgentsResponse } from "./agents.js";
import type { ServerTransport } from "./contracts.js";
import type { JobStore } from "./job-store.js";
import { parseEntriesResponse } from "./transcript.js";
import { isOwnerMessage } from "./turn-sharing.js";
import type { UsageEvent } from "./usage-log.js";

export interface CommandUsage {
  readonly command: string;
  readonly count: number;
  readonly errors: number;
}

export interface UsageSummary {
  readonly total: number;
  readonly byClient: Readonly<Record<string, number>>;
  readonly bySurface: Readonly<Record<string, number>>;
  readonly commands: readonly CommandUsage[];
  readonly outcomes: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<string, number>>;
  readonly durations: Readonly<Record<string, number>>;
  /** Runs per kind of bot targeted: main, test or other. */
  readonly botKinds: Readonly<Record<string, number>>;
}

const bump = (counts: Record<string, number>, key: string | undefined) => {
  if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1;
};

/** Counts of the saved events; most used commands first. */
export function summarizeUsage(events: readonly UsageEvent[]): UsageSummary {
  const byClient: Record<string, number> = {};
  const bySurface: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const durations: Record<string, number> = {};
  const botKinds: Record<string, number> = {};
  const commands = new Map<string, { count: number; errors: number }>();
  for (const e of events) {
    bump(byClient, e.client);
    bump(bySurface, e.surface);
    bump(outcomes, e.status);
    bump(errors, e.errorCode);
    bump(durations, e.duration);
    bump(botKinds, e.bot);
    const c = commands.get(e.command) ?? { count: 0, errors: 0 };
    commands.set(e.command, {
      count: c.count + 1,
      errors: c.errors + (e.status === "error" ? 1 : 0),
    });
  }
  return {
    total: events.length,
    byClient,
    bySurface,
    commands: [...commands]
      .map(([command, c]) => ({ command, ...c }))
      .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command)),
    outcomes,
    errors,
    durations,
    botKinds,
  };
}

export interface BotMessageCount {
  readonly bot: string;
  /** Owner messages sent through grokbot (they match a saved job). */
  readonly viaGrokbot: number;
  /**
   * Owner messages with no saved grokbot job: typed in the Grok Bot app (phone or desktop),
   * or sent by a tool that keeps no job here (an older CLI, a script, another machine).
   */
  readonly other: number;
}

/** Rows read per bot: enough for recent weeks without paging. */
const ROWS_PER_BOT = 200;

/**
 * How many owner messages each bot got since `sinceMs`, split by where they came from.
 * A message sent through grokbot carries the job's id as its clientNonce. The rest were
 * typed in the app or sent by a tool with no job here; the transcript does not say which,
 * nor phone versus desktop (checked 16 Oct: owner rows carry no source field).
 * Read-only, counts only: no message text is kept or returned.
 */
export async function ownerMessageCounts({
  server,
  jobs,
  sinceMs,
  signal,
}: {
  readonly server: ServerTransport;
  readonly jobs: JobStore;
  readonly sinceMs: number;
  readonly signal?: AbortSignal;
}): Promise<BotMessageCount[]> {
  const agents = parseListAgentsResponse(
    await server.call("ListGrokBotAgents", {}, { signal }),
  );
  const ours = new Set((await jobs.list()).map((j) => j.sentMessageId));
  const counts: BotMessageCount[] = [];
  for (const agent of agents) {
    const page = parseEntriesResponse(
      await server.call(
        "ListGrokBotTranscriptEntries",
        { agentId: agent.agentId, sessionId: "", limit: ROWS_PER_BOT },
        { signal },
      ),
    );
    let viaGrokbot = 0;
    let other = 0;
    for (const e of page.entries) {
      if (!isOwnerMessage(e) || (e.timestampMs ?? 0) < sinceMs) continue;
      if (e.clientNonce !== undefined && ours.has(e.clientNonce)) viaGrokbot++;
      else other++;
    }
    counts.push({ bot: agent.name, viaGrokbot, other });
  }
  return counts;
}
