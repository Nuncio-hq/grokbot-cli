import type { JsonObject } from "../contracts.js";
import { fakeServer } from "./fake-server.js";
import { textReplyRow, userRow, type WireEntry } from "./wire-entries.js";

export const QUEUE_AGENT = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const ROSTER = {
  agents: [
    {
      id: "12928587",
      agentId: QUEUE_AGENT,
      name: "Primary Test",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
    },
  ],
};

export interface QueueBotOptions {
  /** Messages the server refuses, as if the bot were paused. */
  readonly refuse?: (text: string) => boolean;
  /** The reply the bot posts at once for a message, ending its run before the call returns. */
  readonly autoReply?: (text: string) => string | undefined;
  /** False: the send is accepted but its echo never shows and the bot stays idle. */
  readonly echoes?: boolean;
}

/**
 * A bot that runs one message at a time, like the live server: each accepted message
 * echoes into the transcript under its own run and the bot runs until `finish` posts
 * that run's reply.
 */
export function queueBot(options: QueueBotOptions = {}) {
  const rows: WireEntry[] = [textReplyRow(139, "older", "run-0")];
  let seq = 139;
  let running = false;
  let lastRun = "run-0";
  const finish = (reply: string) => {
    rows.push(textReplyRow(++seq, reply, lastRun));
    running = false;
  };
  const { server, log } = fakeServer({
    calls: {
      ListGrokBotAgents: [ROSTER],
      ListGrokBotTranscriptEntries: () => ({ entries: [...rows] }),
      ListGrokBotAgentStatuses: () => ({
        statuses: [
          { agentId: QUEUE_AGENT, ...(running && { isRunning: true }) },
        ],
      }),
      SendGrokBotUserMessage: (body: JsonObject) => {
        const text = String(body.text);
        if (options.refuse?.(text))
          return {
            delivery: "GROK_BOT_DELIVERY_REFUSED",
            refusal: { message: "The bot is paused." },
          };
        if (options.echoes === false)
          return { dispatched: true, delivery: "ACCEPTED_TEMPORAL" };
        lastRun = `run-${String(body.messageId)}`;
        rows.push(
          userRow(++seq, text, {
            clientNonce: String(body.messageId),
            requestId: lastRun,
          }),
        );
        running = true;
        const reply = options.autoReply?.(text);
        if (reply !== undefined) finish(reply);
        return { dispatched: true, delivery: "ACCEPTED_TEMPORAL" };
      },
    },
  });
  /** The texts of every send attempt, in order. */
  const sends = () =>
    log
      .filter((c) => c.method === "SendGrokBotUserMessage")
      .map((c) => c.body.text);
  /** The bodies of every send attempt, in order (replyToId included). */
  const sentBodies = () =>
    log.filter((c) => c.method === "SendGrokBotUserMessage").map((c) => c.body);
  return { server, finish, sends, sentBodies };
}
