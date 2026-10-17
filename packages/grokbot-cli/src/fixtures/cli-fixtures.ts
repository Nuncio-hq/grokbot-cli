import { Buffer } from "node:buffer";
import {
  type Agent,
  type CardEntry,
  type LiveStatus,
  parseListAgentsResponse,
  parseTranscriptEntries,
  type TranscriptEntry,
} from "grokbot-core";

const wireAgents = parseListAgentsResponse({
  agents: [
    {
      agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09",
      id: "11",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
      name: "Primary Test",
      harness: "temporal",
    },
    {
      agentId: "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
      id: "12",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
      name: "Staff Test",
      harness: "cursor-agent",
    },
    {
      agentId: "7c0d1e2f-3a4b-4c5d-8e6f-708192a3b4c5",
      id: "13",
      kind: "GROK_BOT_AGENT_KIND_ROOM",
      name: "GB Test Room",
      memberAgentIds: ["f882ec52-17b1-4639-b0fc-07fed7526b09"],
    },
    {
      agentId: "aa11bb22-cc33-4d44-8e55-ff6677889900",
      id: "14",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
      name: "Test-Dev-1",
      harness: "temporal",
    },
    {
      agentId: "bb22cc33-dd44-4e55-8f66-0011223344aa",
      id: "15",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
      name: "Test-Dev-2",
      harness: "temporal",
    },
  ],
});

function pick(index: number): Agent {
  const agent = wireAgents[index];
  if (!agent) throw new Error(`fixture agent ${index} missing`);
  return agent;
}

export const PRIMARY = pick(0);
export const STAFF = pick(1);
export const ROOM = pick(2);
export const DEV_1 = pick(3);
export const DEV_2 = pick(4);
export const AGENTS: readonly Agent[] = [PRIMARY, STAFF, ROOM];

export function status(overrides: Partial<LiveStatus> = {}): LiveStatus {
  return {
    isRunning: false,
    isComposing: false,
    isRetrying: false,
    awaiting: null,
    hasRunningSubagents: false,
    activityTool: undefined,
    boxHandoff: null,
    ...overrides,
  };
}

/** A ListGrokBotTranscriptEntries row whose body is base64 JSON, like the server sends. */
export function row(seq: number, entryKind: string, body: object): object {
  return {
    seq: String(seq),
    entryKind,
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
  };
}

export function blobRow(seq: number, blobHash: string): object {
  return { seq: String(seq), entryKind: "send-message", blobHash };
}

export function entries(rows: readonly object[]): TranscriptEntry[] {
  return parseTranscriptEntries(rows);
}

export function cards(types: readonly string[]): CardEntry[] {
  return entries(
    types.map((type, i) =>
      row(i + 1, "send-message", {
        kind: "send-message",
        message: { type },
      }),
    ),
  ).filter((e): e is CardEntry => e.kind === "card");
}
