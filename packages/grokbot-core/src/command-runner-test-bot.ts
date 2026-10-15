import type { JsonObject } from "./contracts.js";
import {
  TRACE_AGENT_ID as AGENT,
  TRACE_ROWS,
} from "./fixtures/delegation-trace.js";
import { fakeServer } from "./fixtures/fake-server.js";
import {
  textReplyRow,
  userRow,
  type WireEntry,
} from "./fixtures/wire-entries.js";
import type { JobRecord, JobStore } from "./job-store.js";

export { AGENT, TRACE_ROWS };

const ROSTER = {
  agents: [
    {
      id: "12752009",
      agentId: AGENT,
      name: "Trace Bot",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
    },
  ],
};
export const RUNNING = { statuses: [{ agentId: AGENT, isRunning: true }] };
export const IDLE = { statuses: [{ agentId: AGENT }] };
export const ASK = {
  text: "ping",
  agent: "Trace Bot",
  timeout: 1,
  json: false,
};
const OLD_TURN = textReplyRow(141, "old turn");

const echo = (messageId: string) =>
  userRow(142, "Message Test-Dev-1 and ask it to reply PONG.", {
    clientNonce: messageId,
  });
export const rowsFrame = (entries: WireEntry[]) => ({
  rows: { agentId: AGENT, entries },
});
export const liveFrame = (fields: JsonObject = {}) => ({
  agentState: { live: [{ agentId: AGENT, ...fields }] },
});

/** Delegation trace bot: only the old turn until the send lands, then the echo plus `after`. */
export function botAfterSend(
  after: readonly WireEntry[],
  script: Parameters<typeof fakeServer>[0],
) {
  let sent: string | undefined;
  return fakeServer({
    ...script,
    calls: {
      ListGrokBotAgents: [ROSTER],
      SendGrokBotUserMessage: (body: JsonObject) => {
        sent = String(body.messageId);
        return { dispatched: true, delivery: "ACCEPTED_TEMPORAL" };
      },
      ListGrokBotTranscriptEntries: () => ({
        entries: sent ? [OLD_TURN, echo(sent), ...after] : [OLD_TURN],
      }),
      ...script.calls,
    },
  });
}

/** The same bot seen by a later process, after the job's whole trace (#143 to #147) landed. */
export function finishedBot(job: JobRecord) {
  const { progressNote, delegation, sentNote, employeeReply, finalReply } =
    TRACE_ROWS;
  const turn = [progressNote, delegation, sentNote, employeeReply, finalReply];
  return fakeServer({
    calls: {
      ListGrokBotTranscriptEntries: [
        { entries: [OLD_TURN, echo(job.sentMessageId), ...turn] },
      ],
      ListGrokBotAgentStatuses: [IDLE],
    },
  });
}

export async function onlyJob(jobs: JobStore): Promise<JobRecord> {
  const [job, ...rest] = await jobs.list();
  if (!job || rest.length > 0) throw new Error("expected exactly one job");
  return job;
}
