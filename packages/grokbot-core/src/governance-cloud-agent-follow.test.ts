import { describe, expect, it } from "vitest";
import type { CommandInput } from "./command-catalog.js";
import { GrokBotError } from "./contracts.js";
import {
  after,
  BC_A,
  BC_B,
  BC_C,
  cloudAgentRunner,
  composerRow,
  eventFrame,
  heartbeatFrame,
  infoReply,
  SILENT,
  showInput,
  snapshotFrame,
  WORKFLOW,
} from "./fixtures/cloud-agent-kit.js";
import { steps } from "./fixtures/workforce-fakes.js";

const UPDATE = "BACKGROUND_COMPOSER_UPDATE_KIND_";
const APPROVAL = "BACKGROUND_COMPOSER_APPROVAL_";

const running = { workflowStatus: `${WORKFLOW}RUNNING` };
const idle = { workflowStatus: `${WORKFLOW}IDLE` };

/** GetBackgroundComposerInfo replies in order, the last repeating; the conversation is empty. */
const composer = (...states: Record<string, unknown>[]) => ({
  GetBackgroundComposerInfo: steps(...states.map((s) => infoReply(s))),
  GetBackgroundComposerConversation: [{ conversation: [] }],
});

const approval = (over: Record<string, unknown> = {}) => ({
  approvalId: "ap-1",
  state: `${APPROVAL}STATE_PENDING`,
  kind: `${APPROVAL}KIND_MCP_TOOL`,
  headline: "Allow the deploy tool",
  operation: "call",
  target: "deploy",
  expiresAtMs: "1790000900000",
  ...over,
});

const follow = (over: Partial<CommandInput<"cloud-agent">> = {}) =>
  showInput(BC_A, { wait: true, timeout: 600, ...over });

const streamCalls = (log: { method: string; body: unknown }[]) =>
  log
    .filter((c) => c.method === "StreamBackgroundComposerUpdates")
    .map((c) => c.body);

describe("cloud-agent --wait over the update stream", () => {
  it("ends as needs-you when an event says the agent waits on the user", async () => {
    const { run, sleeps, log } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [
          snapshotFrame([composerRow(BC_A, running)]),
          eventFrame(BC_A, { hasPendingInteraction: true }),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toMatchObject({ status: "needs-you" });
    expect(out.outcome).not.toHaveProperty("approval");
    expect(out.cloudAgent).toMatchObject({ status: "running", needsYou: true });
    // The final output still carries the conversation.
    expect([out.messageCount, out.messages]).toEqual([0, []]);
    expect(sleeps).toEqual([]);
    expect(streamCalls(log)).toEqual([{ snapshotN: 50 }]);
  });

  it("ends as needs-you with the approval an event carries, and says what it is for", async () => {
    const { run } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [
          snapshotFrame([composerRow(BC_A, running)]),
          eventFrame(BC_A, {
            kind: `${UPDATE}APPROVAL_CHANGED`,
            approval: approval(),
          }),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toMatchObject({
      status: "needs-you",
      approval: {
        id: "ap-1",
        kind: "mcp_tool",
        headline: "Allow the deploy tool",
        operation: "call",
        target: "deploy",
        expiresAtMs: 1_790_000_900_000,
      },
    });
    expect(out.outcome?.status === "needs-you" && out.outcome.reason).toContain(
      "Allow the deploy tool",
    );
  });

  it("describes an approval without a headline by its operation and target", async () => {
    const { run } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [
          eventFrame(BC_A, {
            kind: `${UPDATE}APPROVAL_CHANGED`,
            approval: approval({ headline: "" }),
          }),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    const reason = out.outcome?.status === "needs-you" && out.outcome.reason;
    expect(reason).toContain("call deploy");
  });

  it("does not wait on an approval that is no longer pending", async () => {
    const { run } = cloudAgentRunner({
      composer: composer(running, idle),
      connections: [
        [
          eventFrame(BC_A, {
            kind: `${UPDATE}APPROVAL_CHANGED`,
            approval: approval({ state: `${APPROVAL}STATE_APPROVED` }),
          }),
          eventFrame(BC_A, idle),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
  });

  it("ends as done when an event says the agent finished, and shows it as the stream left it", async () => {
    const { run, sleeps } = cloudAgentRunner({
      // The read after the event may still be a moment behind the stream.
      composer: composer(running),
      connections: [
        [snapshotFrame([composerRow(BC_A, running)]), eventFrame(BC_A, idle)],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(out.cloudAgent.status).toBe("finished");
    expect(sleeps).toEqual([]);
  });

  it.each([
    ["ERROR", "error"],
    ["EXPIRED", "expired"],
    ["ARCHIVED", "finished"],
  ])("ends as done on a %s event", async (name, status) => {
    const { run } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [eventFrame(BC_A, { workflowStatus: `${WORKFLOW}${name}` })],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect([out.outcome, out.cloudAgent.status]).toEqual([
      { status: "done" },
      status,
    ]);
  });

  it("ends as needs-you when the snapshot row of the agent carries the flag", async () => {
    const { run } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [
          snapshotFrame([
            composerRow(BC_B, running),
            composerRow(BC_A, { ...running, hasPendingInteraction: true }),
          ]),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome?.status).toBe("needs-you");
  });

  it("reports needs-you at once when the first read already carries the flag, without opening the stream", async () => {
    const { run, log, sleeps } = cloudAgentRunner({
      composer: composer({ ...running, hasPendingInteraction: true }),
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome?.status).toBe("needs-you");
    expect(out.cloudAgent.needsYou).toBe(true);
    expect([streamCalls(log), sleeps]).toEqual([[], []]);
  });

  it("counts an idle agent that waits on the user as needing the user, not as done", async () => {
    const { run } = cloudAgentRunner({
      composer: composer({ ...idle, hasPendingInteraction: true }),
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome?.status).toBe("needs-you");
  });

  it("keeps an error or an expiry done even when the flag is still set", async () => {
    const { run } = cloudAgentRunner({
      composer: composer({
        workflowStatus: `${WORKFLOW}ERROR`,
        hasPendingInteraction: true,
      }),
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
  });

  it("ignores events of other agents, however they end or what they wait for", async () => {
    const { run, log } = cloudAgentRunner({
      composer: composer(running, idle),
      connections: [
        [
          snapshotFrame([
            composerRow(BC_B, { ...running, hasPendingInteraction: true }),
            composerRow(BC_C, { workflowStatus: `${WORKFLOW}ERROR` }),
          ]),
          eventFrame(BC_B, { hasPendingInteraction: true }),
          eventFrame(BC_B, {
            kind: `${UPDATE}APPROVAL_CHANGED`,
            approval: approval(),
          }),
          eventFrame(BC_C, idle),
          heartbeatFrame(),
          eventFrame(BC_A, idle),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(out.cloudAgent).toMatchObject({ bcId: BC_A, needsYou: false });
    expect(streamCalls(log)).toHaveLength(1);
  });

  it("drops the updates the app drops, and a flag from a subtree rollup", async () => {
    const { run } = cloudAgentRunner({
      composer: composer(running, idle),
      connections: [
        [
          eventFrame(BC_A, {
            kind: `${UPDATE}MEMBERSHIP_CHANGED`,
            hasPendingInteraction: true,
          }),
          eventFrame(BC_A, {
            kind: `${UPDATE}SUBSCRIPTIONS_CHANGED`,
            workflowStatus: `${WORKFLOW}ERROR`,
          }),
          // No update time: the app drops its status too.
          eventFrame(BC_A, { updatedAtMs: undefined, ...idle }),
          eventFrame(BC_A, {
            isSubtreeRollup: true,
            hasPendingInteraction: true,
          }),
          eventFrame(BC_A, idle),
        ],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(out.cloudAgent.needsYou).toBe(false);
  });

  it("gives up at the timeout, reading the agent once more, and still shows the messages", async () => {
    const { run, sleeps } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [
          snapshotFrame([composerRow(BC_A, running)]),
          after(30_000, heartbeatFrame()),
          after(30_000, heartbeatFrame()),
          // Never reached: the timeout passed.
          eventFrame(BC_A, idle),
        ],
      ],
    });
    const out = await run("cloud-agent", follow({ timeout: 60 }));
    expect(out.outcome).toEqual({
      status: "pending",
      reason: "still running after 60 s",
    });
    expect(out.cloudAgent.status).toBe("running");
    expect(out.messageCount).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("gives up at the timeout when the stream goes quiet, and never waits past it", async () => {
    const { run, sleeps } = cloudAgentRunner({
      composer: composer(running),
      connections: [[snapshotFrame([composerRow(BC_A, running)]), SILENT]],
    });
    const out = await run("cloud-agent", follow({ timeout: 20 }));
    expect(out.outcome?.status).toBe("pending");
    // The silence watchdog was cut to the 20 s that remained, not the full 45 s.
    expect(sleeps).toEqual([20_000]);
  });

  it("treats a connection silent for 45 s as dead and reopens it from the last cursor", async () => {
    const { run, sleeps, log } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [snapshotFrame([composerRow(BC_A, running)], {}, "c1"), SILENT],
        [eventFrame(BC_A, idle, "c2")],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(sleeps[0]).toBe(45_000);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
    expect(streamCalls(log)).toEqual([
      { snapshotN: 50 },
      { snapshotN: 50, resumeCursor: "c1" },
    ]);
  });

  it("reconnects from the last cursor after the stream drops, backing off 1 s, 2 s, 4 s with jitter", async () => {
    const boom = () => new GrokBotError("protocol", "connection reset");
    const { run, sleeps, log } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [snapshotFrame([composerRow(BC_A, running)], {}, "c1"), boom()],
        [heartbeatFrame("c2"), boom()],
        [heartbeatFrame("c3"), boom()],
        [eventFrame(BC_A, { hasPendingInteraction: true }, "c4")],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome?.status).toBe("needs-you");
    expect(sleeps).toHaveLength(3);
    // Equal jitter: each pause is half to all of its backoff.
    [1000, 2000, 4000].forEach((ms, i) => {
      expect(sleeps[i]).toBeGreaterThanOrEqual(ms / 2);
      expect(sleeps[i]).toBeLessThanOrEqual(ms);
    });
    expect(streamCalls(log)).toEqual([
      { snapshotN: 50 },
      { snapshotN: 50, resumeCursor: "c1" },
      { snapshotN: 50, resumeCursor: "c2" },
      { snapshotN: 50, resumeCursor: "c3" },
    ]);
  });

  it("reconnects after the server closes the stream cleanly, and keeps what it learned", async () => {
    const { run, log } = cloudAgentRunner({
      composer: composer(running),
      connections: [
        [snapshotFrame([composerRow(BC_A, running)], {}, "c1")],
        [eventFrame(BC_A, idle, "c2")],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(streamCalls(log)).toEqual([
      { snapshotN: 50 },
      { snapshotN: 50, resumeCursor: "c1" },
    ]);
  });

  it("starts over without the cursor, from a fresh read, when the server gives nothing for it", async () => {
    const boom = () => new GrokBotError("protocol", "connection reset");
    const { run, log } = cloudAgentRunner({
      composer: composer(running, running, idle),
      connections: [
        [snapshotFrame([composerRow(BC_A, running)], {}, "c1"), boom()],
        // The resume is refused: no frame at all.
        [boom()],
        [eventFrame(BC_A, idle, "c3")],
      ],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(streamCalls(log)).toEqual([
      { snapshotN: 50 },
      { snapshotN: 50, resumeCursor: "c1" },
      { snapshotN: 50 },
    ]);
    // The start, the read after the refused cursor, and the one that shows the result.
    expect(
      log.filter((c) => c.method === "GetBackgroundComposerInfo"),
    ).toHaveLength(3);
  });

  it("falls back to polling GetBackgroundComposerInfo when the stream fails before any frame", async () => {
    const { run, sleeps, log } = cloudAgentRunner({
      composer: composer(running, running, running, idle),
      connections: [[new GrokBotError("http", "x failed with HTTP 503: x")]],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome).toEqual({ status: "done" });
    expect(sleeps).toEqual([5000, 10_000]);
    expect(streamCalls(log)).toHaveLength(1);
  });

  it("polling also stops for an agent that starts waiting on the user", async () => {
    const { run, sleeps } = cloudAgentRunner({
      composer: composer(running, running, {
        ...running,
        hasPendingInteraction: true,
      }),
      connections: [[new GrokBotError("protocol", "no stream")]],
    });
    const out = await run("cloud-agent", follow());
    expect(out.outcome?.status).toBe("needs-you");
    expect(sleeps).toEqual([5000]);
  });

  it("does not hide an authentication failure of the stream behind the polling fallback", async () => {
    const { run, log } = cloudAgentRunner({
      composer: composer(running),
      connections: [[new GrokBotError("auth", "token rejected")]],
    });
    const error = await run("cloud-agent", follow()).catch((e: unknown) => e);
    expect([error instanceof GrokBotError && error.code]).toEqual(["auth"]);
    expect(
      log.filter((c) => c.method === "GetBackgroundComposerInfo"),
    ).toHaveLength(1);
  });

  it("stops at once when aborted while following", async () => {
    const controller = new AbortController();
    const { run, events } = cloudAgentRunner({
      composer: composer(running),
      connections: [[snapshotFrame([composerRow(BC_A, running)]), SILENT]],
      // The watchdog is the first thing to sleep: abort from there.
      sleep: async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      },
    });
    const error = await run("cloud-agent", follow(), {
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(events).toContain("stream closed");
  });

  it("does not open the stream without --wait", async () => {
    const { run, log } = cloudAgentRunner({
      composer: composer({ ...running, hasPendingInteraction: true }),
    });
    const out = await run("cloud-agent", showInput(BC_A));
    expect([out.outcome, out.cloudAgent.needsYou, streamCalls(log)]).toEqual([
      undefined,
      true,
      [],
    ]);
  });
});
