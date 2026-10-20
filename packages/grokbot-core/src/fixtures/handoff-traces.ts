import { IDLE_STATUS, type LiveStatus } from "../agent-status.js";
import type { JsonObject } from "../contracts.js";
import type { DelegationContext, DelegationTarget } from "../delegations.js";
import { evaluateDoneRule } from "../done-rule.js";
import { parseTranscriptEntries } from "../transcript.js";
import { findTurn } from "../turn-model.js";
import { fakeServer, type ScriptedStream } from "./fake-server.js";
import {
  delegateReplyRow,
  delegationRow,
  sendMessageRow,
  userRow,
  type WireAgent,
  type WireEntry,
  withEntryId,
} from "./wire-entries.js";

/**
 * Bot-to-bot hand-offs in the shapes decoded live on 19 Oct 2026 (two test bots, text
 * replaced). The sender's transcript holds an assistant row `agent-outbound-<hex>` for each
 * message; the receiver's holds a user row with `clientNonce: "<hex>"` (same hex) under its
 * own requestId, and its answer is its own `agent-outbound-<hex2>` row, which lands on the
 * sender as a user row with `clientNonce: "<hex2>"`.
 */
export const PRIMARY: WireAgent = {
  id: "f882ec52-17b1-4639-b0fc-07fed7526b09",
  name: "Primary Test",
};
export const STAFF: WireAgent = {
  id: "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
  name: "Staff Test",
};
export const DEV: WireAgent = {
  id: "dddddddd-0000-4000-8000-000000000000",
  name: "Dev-A",
};

/** The hand-off the sender wrote: its `agent-outbound-<hex>` row to `to`. */
export function outboundRow(
  seq: number,
  hex: string,
  content: string,
  to: WireAgent,
  requestId: string,
  timestampMs: number,
): WireEntry {
  return withEntryId(
    delegationRow(seq, content, to, { requestId, timestampMs }),
    `agent-outbound-${hex}`,
  );
}

/** The message as it landed on the receiver (or an answer landing on the sender). */
export function inboundRow(
  seq: number,
  hex: string,
  content: string,
  from: WireAgent,
  requestId: string,
  timestampMs: number,
): WireEntry {
  return delegateReplyRow(seq, content, from, {
    clientNonce: hex,
    requestId,
    timestampMs,
  });
}

/** A text reply of the bot to the owner. */
export function noteRow(
  seq: number,
  content: string,
  requestId: string,
  timestampMs: number,
): WireEntry {
  return sendMessageRow(seq, { type: "text", content }, requestId, seq, {
    timestampMs,
  });
}

/** The owner's message that starts the job. */
export function ownerRow(
  seq: number,
  content: string,
  messageId: string,
  requestId: string,
  timestampMs: number,
): WireEntry {
  return userRow(seq, content, {
    clientNonce: messageId,
    requestId,
    timestampMs,
  });
}

export interface Scenario {
  /** The sender's job. */
  readonly messageId: string;
  /** The bot the job runs on and its rows. */
  readonly sender: WireAgent;
  readonly senderRows: readonly WireEntry[];
  /** Rows of every other bot, by agentId. */
  readonly others: Readonly<Record<string, readonly WireEntry[]>>;
}

const seconds = (base: number) => (s: number) => base + Math.round(s * 1000);

/**
 * The 19 Oct 92 s hand-off: Primary asks Staff for a 45 s job, ends its turn, Staff's
 * answer opens a new run on Primary, whose final reply ends the job.
 */
export function longHandoff(base: number): Scenario & {
  readonly upToNote: readonly WireEntry[];
  readonly staffAnswer: WireEntry;
} {
  const t = seconds(base);
  const senderRows = [
    withEntryId(
      ownerRow(303, "Ask Staff Test for a 45 s job.", "long-1", "rs-1", t(0)),
      "t104u",
    ),
    noteRow(304, "Sending it now.", "rs-1", t(1)),
    outboundRow(
      305,
      "a0b1c2",
      "Run a 45 s job, then reply DONE-A.",
      STAFF,
      "rs-1",
      t(9),
    ),
    noteRow(306, "Asked, waiting.", "rs-1", t(12)),
    inboundRow(307, "a0b1c3", "DONE-A", STAFF, "rs-2", t(78)),
    noteRow(308, "FINAL: DONE-A", "rs-2", t(92)),
  ];
  const staffAnswer = outboundRow(
    122,
    "a0b1c3",
    "DONE-A",
    PRIMARY,
    "rq-1",
    t(77.9),
  );
  return {
    messageId: "long-1",
    sender: PRIMARY,
    senderRows,
    others: {
      [STAFF.id]: [
        noteRow(120, "older note", "rq-0", t(-3600)),
        inboundRow(
          121,
          "a0b1c2",
          "Run a 45 s job, then reply DONE-A.",
          PRIMARY,
          "rq-1",
          t(9.1),
        ),
        staffAnswer,
      ],
    },
    upToNote: senderRows.slice(0, 4),
    staffAnswer,
  };
}

/**
 * Staff sends Primary a held note (no row ever appears on Primary) and a woken one
 * (Primary runs briefly and posts nothing), then posts its own final reply.
 */
export function heldAndUnanswered(base: number): Scenario {
  const t = seconds(base);
  return {
    messageId: "hold-1",
    sender: STAFF,
    senderRows: [
      withEntryId(
        ownerRow(
          125,
          "Send Primary one held and one woken note.",
          "hold-1",
          "rs-1",
          t(0),
        ),
        "t41u",
      ),
      noteRow(126, "Sending both now.", "rs-1", t(1)),
      outboundRow(
        127,
        "b0c1d2",
        "HOLD: no reply needed",
        PRIMARY,
        "rs-1",
        t(1.5),
      ),
      outboundRow(
        128,
        "b0c1d3",
        "WAKE: no reply needed",
        PRIMARY,
        "rs-1",
        t(8),
      ),
      noteRow(129, "Sent one held, one woken.", "rs-1", t(9)),
    ],
    others: {
      [PRIMARY.id]: [
        noteRow(318, "older note", "rq-0", t(-3600)),
        inboundRow(
          319,
          "b0c1d3",
          "WAKE: no reply needed",
          STAFF,
          "rq-wake",
          t(8.2),
        ),
      ],
    },
  };
}

/**
 * Two hand-offs to one bot, each answered under its own run, B's answer first. `landed`
 * lists the answers that have reached the sender, in the order they landed; once both
 * have, the sender's last run posts its final reply.
 */
export function twoHandoffs(
  base: number,
  landed: readonly ("a" | "b")[],
): Scenario {
  const t = seconds(base);
  const answers = {
    a: inboundRow(25, "aa0099", "Task A done.", STAFF, "rs-3", t(40.1)),
    b: inboundRow(24, "bb0099", "Task B done.", STAFF, "rs-2", t(30.1)),
  };
  const last = landed.at(-1);
  return {
    messageId: "two-1",
    sender: PRIMARY,
    senderRows: [
      ownerRow(20, "Hand Staff two tasks.", "two-1", "rs-1", t(0)),
      outboundRow(21, "aa0001", "Task A", STAFF, "rs-1", t(2)),
      outboundRow(22, "bb0002", "Task B", STAFF, "rs-1", t(3)),
      noteRow(23, "Both handed over.", "rs-1", t(4)),
      ...landed.map((key) => answers[key]),
      ...(landed.length === 2 && last !== undefined
        ? [
            noteRow(
              26,
              "FINAL: A and B done",
              last === "a" ? "rs-3" : "rs-2",
              t(45),
            ),
          ]
        : []),
    ],
    others: {
      [STAFF.id]: [
        inboundRow(10, "aa0001", "Task A", PRIMARY, "rq-a", t(2.1)),
        inboundRow(11, "bb0002", "Task B", PRIMARY, "rq-b", t(3.1)),
        outboundRow(12, "bb0099", "Task B done.", PRIMARY, "rq-b", t(30)),
        outboundRow(13, "aa0099", "Task A done.", PRIMARY, "rq-a", t(40)),
      ],
    },
  };
}

/**
 * Staff passes the hand-off on to a third bot and answers Primary from the run that bot's
 * answer opened (one level deep), or hands on again from that run (two levels).
 */
export function chainedHandoff(
  base: number,
  depth: 1 | 2,
  landed = false,
): Scenario {
  const t = seconds(base);
  return {
    messageId: "chain-1",
    sender: PRIMARY,
    senderRows: [
      ownerRow(40, "Ask Staff Test for a total.", "chain-1", "rs-1", t(0)),
      outboundRow(41, "cc0001", "Compute the total.", STAFF, "rs-1", t(2)),
      noteRow(42, "Asked Staff Test.", "rs-1", t(3)),
      ...(depth === 1 && landed
        ? [inboundRow(43, "cc0003", "Total is 7.", STAFF, "rs-2", t(30.1))]
        : []),
    ],
    others: {
      [STAFF.id]: [
        inboundRow(30, "cc0001", "Compute the total.", PRIMARY, "rq-1", t(2.1)),
        outboundRow(31, "dd0001", "Add these.", DEV, "rq-1", t(3)),
        inboundRow(32, "dd0002", "Sum is 7.", DEV, "rq-2", t(20)),
        depth === 1
          ? outboundRow(33, "cc0003", "Total is 7.", PRIMARY, "rq-2", t(30))
          : outboundRow(33, "dd0003", "Check it again.", DEV, "rq-2", t(30)),
      ],
    },
  };
}

/** A delegate that is working, as a read of its status shows it. */
export const RUNNING_STATUS: LiveStatus = { ...IDLE_STATUS, isRunning: true };

/** What one read of `rows` of a delegate shows; `windowStartMs` unset means the page was short. */
export function readOf(
  rows: readonly WireEntry[],
  readAtMs: number,
  status: LiveStatus = IDLE_STATUS,
  windowStartMs?: number,
): DelegationTarget {
  return {
    status,
    rows: parseTranscriptEntries(rows),
    windowStartMs,
    readAtMs,
  };
}

/** A delegate that was not read, as while it is working. */
export function unreadOf(
  readAtMs: number,
  status: LiveStatus = RUNNING_STATUS,
): DelegationTarget {
  return { status, rows: undefined, windowStartMs: undefined, readAtMs };
}

export const AWAITING_STATUS: LiveStatus = {
  ...IDLE_STATUS,
  awaiting: { reason: "needs the owner" },
};

export function contextOf(
  sender: WireAgent,
  targets: Readonly<Record<string, DelegationTarget>>,
): DelegationContext {
  return { selfId: sender.id, targets: new Map(Object.entries(targets)) };
}

/** A fake server for two or more bots that each hold their own rows and live status. */
export function botsServer(
  rows: Readonly<Record<string, readonly WireEntry[]>>,
  live: Readonly<Record<string, JsonObject>> = {},
  streams: readonly ScriptedStream[] = [],
) {
  return fakeServer({
    calls: {
      ListGrokBotTranscriptEntries: (body) => {
        const limit = typeof body.limit === "number" ? body.limit : 50;
        const held = rows[String(body.agentId)] ?? [];
        return { entries: held.slice(-limit) };
      },
      ListGrokBotAgentStatuses: (body) => ({
        statuses: (Array.isArray(body.agentIds) ? body.agentIds : []).map(
          (id) => ({ agentId: String(id), live: live[String(id)] ?? {} }),
        ),
      }),
    },
    streams,
  });
}

/**
 * The Done Rule on the sender's rows with the reads of its delegates, as one string:
 * `running:<reason>`, `done:<finalReply>` or the verdict's status.
 */
export function judge(
  rows: readonly WireEntry[],
  messageId: string,
  delegations?: DelegationContext,
  status: LiveStatus = IDLE_STATUS,
): string {
  const v = evaluateDoneRule({
    entries: parseTranscriptEntries(rows),
    sentMessageId: messageId,
    status,
    ...(delegations && { delegations }),
  });
  if (v.status === "running") return `running:${v.reason}`;
  return v.status === "done" ? `done:${v.finalReply}` : v.status;
}

/** The turn's open delegations as `entryId:state`, in the order they were sent. */
export function openOf(
  rows: readonly WireEntry[],
  messageId: string,
  delegations?: DelegationContext,
): string[] {
  const turn = findTurn(
    parseTranscriptEntries(rows),
    messageId,
    undefined,
    delegations,
  );
  return (turn?.delegations.open ?? []).map(
    (d) => `${d.entryId}:${d.state.kind}`,
  );
}
