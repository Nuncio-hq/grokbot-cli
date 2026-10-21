import { Buffer } from "node:buffer";

export type WireEntry = {
  seq: string;
  updatedSeq: string;
  entryId: string;
  entryKind: string;
  body?: string;
  blobHash?: string;
};

function encodeBody(body: unknown): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

export function wireEntry(
  seq: number,
  entryKind: string,
  body: Record<string, unknown>,
  updatedSeq: number = seq,
): WireEntry {
  return {
    seq: String(seq),
    updatedSeq: String(updatedSeq),
    entryId: `entry-${seq}`,
    entryKind,
    body: encodeBody(body),
  };
}

/** The row under a live-shaped id (`t51u`, `t51s0`), set as its entryId and its body id. */
export function withEntryId(row: WireEntry, entryId: string): WireEntry {
  if (row.body === undefined) return { ...row, entryId };
  const body = JSON.parse(Buffer.from(row.body, "base64").toString("utf8"));
  return { ...row, entryId, body: encodeBody({ ...body, id: entryId }) };
}

export function userRow(
  seq: number,
  content: string,
  extra: Record<string, unknown> = {},
): WireEntry {
  return wireEntry(seq, "message", {
    kind: "message",
    role: "user",
    content,
    id: `u${seq}`,
    isStreaming: false,
    timestampMs: 1_791_948_600_000 + seq,
    ...extra,
  });
}

export function assistantRow(
  seq: number,
  content: string,
  extra: Record<string, unknown> = {},
): WireEntry {
  return wireEntry(seq, "message", {
    kind: "message",
    role: "assistant",
    content,
    id: `a${seq}`,
    timestampMs: 1_791_948_600_000 + seq,
    ...extra,
  });
}

export interface WireAgent {
  readonly id: string;
  readonly name: string;
}

/** Our bot messaging another bot: an assistant row with `toAgent {id, name, kind}`. */
export function delegationRow(
  seq: number,
  content: string,
  to: WireAgent,
  extra: Record<string, unknown> = {},
): WireEntry {
  const toAgent = { id: to.id, name: to.name, kind: "agent" };
  return assistantRow(seq, content, { toAgent, ...extra });
}

/** Another bot's message landing in our chat: a user row with `fromAgent {id, name}`. */
export function delegateReplyRow(
  seq: number,
  content: string,
  from: WireAgent,
  extra: Record<string, unknown> = {},
): WireEntry {
  const fromAgent = { id: from.id, name: from.name };
  return userRow(seq, content, { fromAgent, ...extra });
}

/** `requestId: null` writes a legacy row without one. */
export function sendMessageRow(
  seq: number,
  message: Record<string, unknown>,
  requestId: string | null = "req-default",
  updatedSeq: number = seq,
  extra: Record<string, unknown> = {},
): WireEntry {
  return wireEntry(
    seq,
    "send-message",
    {
      kind: "send-message",
      id: `t${seq}`,
      message,
      ...(requestId === null ? {} : { requestId }),
      timestampMs: 1_791_948_600_000 + seq,
      ...extra,
    },
    updatedSeq,
  );
}

export function textReplyRow(
  seq: number,
  content: string,
  requestId: string | null = "req-default",
  extra: { updatedSeq?: number; isStreaming?: boolean } = {},
): WireEntry {
  const { updatedSeq = seq, ...body } = extra;
  return sendMessageRow(
    seq,
    { type: "text", content },
    requestId,
    updatedSeq,
    body,
  );
}

export function blobRow(
  seq: number,
  entryKind: string,
  blobHash: string,
): WireEntry {
  return {
    seq: String(seq),
    updatedSeq: String(seq),
    entryId: `entry-${seq}`,
    entryKind,
    blobHash,
  };
}
