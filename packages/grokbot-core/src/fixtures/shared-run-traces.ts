import {
  assistantRow,
  sendMessageRow,
  textReplyRow,
  userRow,
  type WireEntry,
  withEntryId,
} from "./wire-entries.js";

/** A cloud agent as the live rows name it: an assistant `toAgent` and a user `fromAgent`. */
const CLOUD_AGENT_ID = "bc-00000000-0000-4000-8000-0000000000aa";

export const TICKET_A_ID = "aaaa0001-0000-4000-8000-000000000000";
export const TICKET_B_ID = "bbbb0002-0000-4000-8000-000000000000";

/**
 * Shape of the 15 Oct spike on Primary Test (#169 to #179), text replaced. Two messages
 * were sent back to back. Run A posted one note, then message B arrived and run A posted
 * nothing more: run B did ticket B and started ticket A's cloud agent, and the cloud
 * agent's reply started run C, whose final reply is ticket A's result.
 */
const SPIKE_TRACE = {
  echoA: withEntryId(
    userRow(169, "Ticket A: start one cloud agent to count files.", {
      clientNonce: TICKET_A_ID,
      requestId: "ra000001",
    }),
    "t57u",
  ),
  noteA: withEntryId(
    textReplyRow(170, "Starting the cloud agent for ticket A now.", "ra000001"),
    "t57s0",
  ),
  echoB: withEntryId(
    userRow(171, "Ticket B: print a version number.", {
      clientNonce: TICKET_B_ID,
      requestId: "rb000002",
    }),
    "t58u",
  ),
  noteB: withEntryId(
    textReplyRow(172, "Running ticket B now; ticket A is next.", "rb000002"),
    "t58s0",
  ),
  delegation: withEntryId(
    assistantRow(173, "Count the files, read-only.", {
      toAgent: {
        id: CLOUD_AGENT_ID,
        name: CLOUD_AGENT_ID,
        kind: "cloud-agent",
      },
      requestId: "rb000002",
    }),
    "agent-outbound-0001",
  ),
  resultB: withEntryId(
    textReplyRow(174, "RESULT B: 1.2.3", "rb000002"),
    "t58s1",
  ),
  agentCard: withEntryId(
    sendMessageRow(
      175,
      { type: "cursor-agent", bcId: CLOUD_AGENT_ID, title: "File count" },
      "rb000002",
    ),
    "t58s2",
  ),
  runningNote: withEntryId(
    textReplyRow(176, "Ticket A's cloud agent is running.", "rb000002"),
    "t58s3",
  ),
  agentReply: withEntryId(
    userRow(177, "42", {
      fromAgent: {
        id: CLOUD_AGENT_ID,
        name: "File count",
        kind: "cloud-agent",
      },
      requestId: "rc000003",
    }),
    "agent-inbound-0001",
  ),
  resultA: withEntryId(textReplyRow(179, "RESULT A: 42", "rc000003"), "t58s4"),
} satisfies Record<string, WireEntry>;

export const SPIKE_IN_ORDER: readonly WireEntry[] = Object.values(SPIKE_TRACE);

/** Rows of the spike up to #seq inclusive. */
export function spikeUpTo(seq: number): WireEntry[] {
  return SPIKE_IN_ORDER.filter((row) => Number(row.seq) <= seq);
}

export const PROBE_A_ID = "aaaa0003-0000-4000-8000-000000000000";
export const PROBE_B_ID = "bbbb0004-0000-4000-8000-000000000000";

/**
 * 16 Oct probe on Primary Test (#180 to #182): message B arrived 1.7 s after A, before
 * run A posted anything. Run A never posted; run B replied once, and the bot went idle.
 */
export const PROBE_TRACE: readonly WireEntry[] = [
  withEntryId(
    userRow(
      180,
      "Wait 25 seconds using a shell sleep, then reply with exactly: ALPHA",
      { clientNonce: PROBE_A_ID, requestId: "ra000005" },
    ),
    "t59u",
  ),
  withEntryId(
    userRow(181, "Reply with exactly: BETA", {
      clientNonce: PROBE_B_ID,
      requestId: "rb000006",
    }),
    "t60u",
  ),
  withEntryId(textReplyRow(182, "BETA", "rb000006"), "t60s0"),
];
