import {
  delegateReplyRow,
  delegationRow,
  textReplyRow,
  userRow,
  type WireAgent,
  type WireEntry,
} from "./wire-entries.js";

/** Redacted replay of the 13 Oct 16.8 s delegation test (docs/index.html drawer 04), in the live wire shape. */
export const TRACE_MESSAGE_ID = "04365d83-0000-4000-8000-000000000000";
export const TRACE_AGENT_ID = "9823898c-0000-4000-8000-000000000000";
export const TRACE_BASELINE_SEQ = "141";
const TEST_DEV_1: WireAgent = {
  id: "202b7c6b-0000-4000-8000-000000000000",
  name: "Test-Dev-1",
};

export const TRACE_ROWS = {
  echo: userRow(142, "Message Test-Dev-1 and ask it to reply PONG.", {
    clientNonce: TRACE_MESSAGE_ID,
    requestId: "60a34167",
  }),
  progressNote: textReplyRow(143, "Messaging Test-Dev-1 now.", "60a34167"),
  delegation: delegationRow(144, "Test ping: please reply PONG.", TEST_DEV_1, {
    requestId: "60a34167",
  }),
  sentNote: textReplyRow(
    145,
    "I've sent it to Test-Dev-1, but the reply doesn't come back right away.",
    "60a34167",
  ),
  employeeReply: delegateReplyRow(146, "PONG", TEST_DEV_1, {
    requestId: "0383ac5f",
  }),
  finalReply: textReplyRow(147, "RESULT: PONG", "0383ac5f"),
} satisfies Record<string, WireEntry>;

export const TRACE_IN_ORDER: readonly WireEntry[] = [
  TRACE_ROWS.echo,
  TRACE_ROWS.progressNote,
  TRACE_ROWS.delegation,
  TRACE_ROWS.sentNote,
  TRACE_ROWS.employeeReply,
  TRACE_ROWS.finalReply,
];

export const STAFF_TEST: WireAgent = {
  id: "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
  name: "Staff Test",
};
export const LIVE_MESSAGE_ID = "5f0c1d2e-0000-4000-8000-000000000000";

/** 14 Oct live run on Primary Test (#109..#114, text shortened): `ask` returned #110. */
export const LIVE_TRACE: readonly WireEntry[] = [
  userRow(109, "SendToAgent Staff Test for PONG, answer RESULT: <reply>.", {
    clientNonce: LIVE_MESSAGE_ID,
  }),
  textReplyRow(110, "Asking Staff Test again now."),
  delegationRow(
    111,
    "Please reply to me with exactly the word PONG.",
    STAFF_TEST,
  ),
  textReplyRow(112, "I've asked Staff Test; no reply has arrived yet."),
  delegateReplyRow(113, "PONG", STAFF_TEST, {
    clientNonce: "7a1b2c3d-0000-4000-8000-000000000000",
  }),
  textReplyRow(114, "RESULT: PONG"),
];

/** Rows of `trace` up to #seq inclusive. */
export function traceUpTo(
  seq: number,
  trace: readonly WireEntry[] = TRACE_IN_ORDER,
): WireEntry[] {
  return trace.filter((row) => Number(row.seq) <= seq);
}
