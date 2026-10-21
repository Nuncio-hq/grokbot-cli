import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  BC_A,
  BC_B,
  BC_C,
  BOT_ID,
  cloudAgentRunner,
  composerRow as composer,
  infoReply as info,
  listInput,
  PRIMARY,
  STAFF,
  showInput,
  snapshotFrame as snapshot,
  WORKFLOW,
} from "./fixtures/cloud-agent-kit.js";
import { steps } from "./fixtures/workforce-fakes.js";
import {
  assertBackgroundComposerMethodAllowed,
  assertMethodAllowed,
} from "./method-safety.js";

const KIND = "GROK_BOT_CLOUD_AGENT_WATCH_KIND_";
const watcher = (agentId: string, kind: string) => ({
  agentId,
  kind: `${KIND}${kind}`,
  durable: true,
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof GrokBotError
      ? [error.code, error.message]
      : ["other", String(error)];
  }
  return ["no error"];
};

const http = (method: string, status: number) =>
  new GrokBotError("http", `${method} failed with HTTP ${status}: x`);

describe("cloud-agents", () => {
  it("lists the account's agents from the first frame, asks for `limit`, and closes the stream", async () => {
    const { run, log, events } = cloudAgentRunner({
      frames: [
        { heartbeat: { resumeCursor: "c0" } },
        snapshot([composer(BC_A), composer(BC_B, { name: "Second" })], {
          hasMore: true,
        }),
        snapshot([composer(BC_C)]),
      ],
    });
    const out = await run("cloud-agents", listInput({ limit: 7 }));
    expect(out.cloudAgents.map((a) => [a.bcId, a.name, a.status])).toEqual([
      [BC_A, "Agent a1", "finished"],
      [BC_B, "Second", "finished"],
    ]);
    expect([out.hasMore, out.launchedBy]).toEqual([true, null]);
    expect(log).toEqual([
      {
        via: "composer",
        method: "StreamBackgroundComposerUpdates",
        body: { snapshotN: 7 },
        confirmed: false,
      },
    ]);
    // It stopped at the snapshot: the later frame was never pulled, and the stream closed.
    expect(events).toEqual([
      "stream open",
      "frame 1",
      "frame 2",
      "stream closed",
    ]);
  });

  it("marks the agents the snapshot flags as waiting on the user, and no other", async () => {
    const { run } = cloudAgentRunner({
      frames: [
        snapshot([
          composer(BC_A, { hasPendingInteraction: true }),
          composer(BC_B),
          composer(BC_C, { hasPendingInteraction: false }),
        ]),
      ],
    });
    const out = await run("cloud-agents", listInput());
    expect(out.cloudAgents.map((a) => [a.bcId, a.needsYou])).toEqual([
      [BC_A, true],
      [BC_B, false],
      [BC_C, false],
    ]);
  });

  it("lists nothing for an account with no cloud agents", async () => {
    const { run } = cloudAgentRunner({ frames: [snapshot([])] });
    expect(await run("cloud-agents", listInput())).toEqual({
      cloudAgents: [],
      hasMore: false,
      launchedBy: null,
    });
  });

  it("fails when the stream ends without a snapshot", async () => {
    const { run } = cloudAgentRunner({ frames: [{ heartbeat: {} }] });
    expect(await failure(run("cloud-agents", listInput()))).toEqual([
      "protocol",
      "StreamBackgroundComposerUpdates ended without a snapshot.",
    ]);
  });

  it("keeps only the agents the named bot launched, and says which bot", async () => {
    const { run, log } = cloudAgentRunner({
      frames: [snapshot([composer(BC_A), composer(BC_B), composer(BC_C)])],
      server: {
        GetGrokBotCloudAgentWatchers: (body) =>
          ({
            [BC_A]: { watchers: [watcher(BOT_ID, "LAUNCH")] },
            // Another bot launched it; this bot only follows it.
            [BC_B]: {
              watchers: [watcher(STAFF, "LAUNCH"), watcher(BOT_ID, "REPLY")],
            },
            [BC_C]: { watchers: [watcher(BOT_ID, "LAUNCH")] },
          })[body.bcId as string],
      },
    });
    const out = await run("cloud-agents", listInput({ agent: "Primary Test" }));
    expect(out.cloudAgents.map((a) => a.bcId)).toEqual([BC_A, BC_C]);
    expect(out.launchedBy).toEqual({ agentId: PRIMARY, name: "Primary Test" });
    expect(
      log
        .filter((c) => c.method === "GetGrokBotCloudAgentWatchers")
        .map((c) => c.body.bcId)
        .sort(),
    ).toEqual([BC_A, BC_B, BC_C]);
  });

  it("reports an empty filtered list as no match, still naming the bot", async () => {
    const { run } = cloudAgentRunner({
      frames: [snapshot([composer(BC_A)], { hasMore: true })],
      server: { GetGrokBotCloudAgentWatchers: [{}] },
    });
    expect(await run("cloud-agents", listInput({ agent: STAFF }))).toEqual({
      cloudAgents: [],
      hasMore: true,
      launchedBy: { agentId: STAFF, name: "Staff Test" },
    });
  });

  it("resolves the bot before it reads the list, so a mistyped bot costs no list call", async () => {
    const { run, log } = cloudAgentRunner({ frames: [snapshot([])] });
    const [code, message] = await failure(
      run("cloud-agents", listInput({ agent: "Nobody" })),
    );
    expect(code).toBe("not-found");
    expect(message).toContain('No agent matches "Nobody"');
    expect(log.map((c) => c.method)).toEqual(["ListGrokBotAgents"]);
  });

  it("does not read the roster or any watcher without --agent", async () => {
    const { run, log } = cloudAgentRunner({
      frames: [snapshot([composer(BC_A)])],
    });
    await run("cloud-agents", listInput());
    expect(log.map((c) => c.method)).toEqual([
      "StreamBackgroundComposerUpdates",
    ]);
  });

  it("stops at once when aborted", async () => {
    const { run } = cloudAgentRunner({ frames: [snapshot([composer(BC_A)])] });
    const controller = new AbortController();
    controller.abort();
    const error = await run("cloud-agents", listInput(), {
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
  });
});

const bubble = (type: "HUMAN" | "AI", text: string, over = {}) => ({
  type: `MESSAGE_TYPE_${type}`,
  bubbleId: `bubble-${text}`,
  text,
  ...over,
});
const thread = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    bubble(i % 2 === 0 ? "HUMAN" : "AI", `message ${i + 1}`),
  );

describe("cloud-agent", () => {
  it("reads the detail and the exchange-only conversation, keeping the last N messages in order", async () => {
    const { run, log } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [info()],
        GetBackgroundComposerConversation: [{ conversation: thread(5) }],
      },
    });
    const out = await run("cloud-agent", showInput(BC_A, { messages: 2 }));
    expect(out.cloudAgent).toMatchObject({
      bcId: BC_A,
      status: "finished",
      repo: "https://example.test/acme/widgets",
      branch: "cursor/work",
      baseBranch: "main",
      prStatus: "open",
      prUrl: "https://example.test/acme/widgets/pull/7",
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
      model: { name: "example-model", maxMode: false },
    });
    expect(out.messages.map((m) => [m.role, m.text])).toEqual([
      ["assistant", "message 4"],
      ["human", "message 5"],
    ]);
    expect([out.messageCount, out.outcome]).toEqual([5, undefined]);
    expect(log.map((c) => [c.method, c.body, c.confirmed])).toEqual([
      ["GetBackgroundComposerInfo", { bcId: BC_A }, false],
      [
        "GetBackgroundComposerConversation",
        { bcId: BC_A, exchangeOnly: true },
        false,
      ],
    ]);
  });

  it("shows every message when the conversation is shorter than N", async () => {
    const { run } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [info()],
        GetBackgroundComposerConversation: [{ conversation: thread(2) }],
      },
    });
    const out = await run("cloud-agent", showInput(BC_A));
    expect([out.messages.length, out.messageCount]).toEqual([2, 2]);
  });

  it("counts only the messages a person reads, not thinking or tool steps", async () => {
    const { run } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [info()],
        GetBackgroundComposerConversation: [
          {
            conversation: [
              bubble("HUMAN", "do it"),
              bubble("AI", "", { thinking: { text: "..." } }),
              bubble("AI", "ran grep", { toolResults: [{ name: "grep" }] }),
              bubble("AI", "finished"),
            ],
          },
        ],
      },
    });
    const out = await run("cloud-agent", showInput(BC_A));
    expect([out.messages.map((m) => m.text), out.messageCount]).toEqual([
      ["do it", "finished"],
      2,
    ]);
  });

  it("reads no conversation at all for --messages 0", async () => {
    const { run, log } = cloudAgentRunner({
      composer: { GetBackgroundComposerInfo: [info()] },
    });
    const out = await run("cloud-agent", showInput(BC_A, { messages: 0 }));
    expect([out.messages, out.messageCount]).toEqual([[], null]);
    expect(log.map((c) => c.method)).toEqual(["GetBackgroundComposerInfo"]);
  });

  it.each([
    [400, "InvalidArgument"],
    [501, "Unimplemented"],
  ])(
    "falls back to the whole conversation when exchangeOnly is refused (HTTP %s, %s)",
    async (status) => {
      const { run, log } = cloudAgentRunner({
        composer: {
          GetBackgroundComposerInfo: [info()],
          GetBackgroundComposerConversation: steps(
            http("GetBackgroundComposerConversation", status),
            { conversation: thread(3) },
          ),
        },
      });
      const out = await run("cloud-agent", showInput(BC_A));
      expect(out.messageCount).toBe(3);
      expect(
        log
          .filter((c) => c.method === "GetBackgroundComposerConversation")
          .map((c) => c.body),
      ).toEqual([{ bcId: BC_A, exchangeOnly: true }, { bcId: BC_A }]);
    },
  );

  it("does not hide other failures behind the fallback", async () => {
    const { run, log } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [info()],
        GetBackgroundComposerConversation: [
          http("GetBackgroundComposerConversation", 500),
        ],
      },
    });
    expect(await failure(run("cloud-agent", showInput(BC_A)))).toEqual([
      "http",
      "GetBackgroundComposerConversation failed with HTTP 500: x",
    ]);
    expect(
      log.filter((c) => c.method === "GetBackgroundComposerConversation"),
    ).toHaveLength(1);
  });

  it.each([
    ["not-an-id"],
    [""],
    ["bc-"],
    ["bc-has space"],
    ["f882ec52-17b1-4639-b0fc-07fed7526b09"],
    ["bc-../../x"],
  ])("refuses %j as a cloud agent id before any call", async (bcId) => {
    const { run, log } = cloudAgentRunner();
    const [code, message] = await failure(run("cloud-agent", showInput(bcId)));
    expect(code).toBe("not-found");
    expect(message).toContain("is not a cloud agent id");
    expect(log).toEqual([]);
  });

  it("trims the id before it checks it", async () => {
    const { run, log } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [info()],
        GetBackgroundComposerConversation: [{ conversation: [] }],
      },
    });
    await run("cloud-agent", showInput(`  ${BC_A}\n`));
    expect(log[0]?.body).toEqual({ bcId: BC_A });
  });

  it("says no such cloud agent when the server answers 404", async () => {
    const { run } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [http("GetBackgroundComposerInfo", 404)],
      },
    });
    expect(await failure(run("cloud-agent", showInput(BC_B)))).toEqual([
      "not-found",
      `No cloud agent ${BC_B} on this account. grokbot cloud-agents lists them.`,
    ]);
  });

  it("passes any other info failure through", async () => {
    const { run } = cloudAgentRunner({
      composer: {
        GetBackgroundComposerInfo: [http("GetBackgroundComposerInfo", 503)],
      },
    });
    expect(await failure(run("cloud-agent", showInput(BC_A)))).toEqual([
      "http",
      "GetBackgroundComposerInfo failed with HTTP 503: x",
    ]);
  });
});

describe("cloud-agent --wait, with an update stream that delivers nothing (polling)", () => {
  const workflow = (name: string) =>
    info({ workflowStatus: `${WORKFLOW}${name}` });
  const polling = (...states: string[]) => ({
    GetBackgroundComposerInfo: steps(...states.map(workflow)),
    GetBackgroundComposerConversation: [{ conversation: thread(2) }],
  });

  it("returns at once, without sleeping, for an agent that is not running", async () => {
    const { run, sleeps, log } = cloudAgentRunner({
      composer: polling("IDLE"),
    });
    const out = await run("cloud-agent", showInput(BC_A, { wait: true }));
    expect([out.outcome, sleeps]).toEqual([{ status: "done" }, []]);
    expect(
      log.filter((c) => c.method === "GetBackgroundComposerInfo"),
    ).toHaveLength(1);
  });

  it("polls with a growing pause, 5 s up to 30 s, until the agent finishes, then reads the conversation once", async () => {
    // The first read is the follow's own start; the poll fallback reads fresh after it.
    const { run, sleeps, log } = cloudAgentRunner({
      composer: polling(
        "NOT_YET_STARTED",
        "RUNNING",
        "WAITING_FOR_BACKGROUND_WORK",
        "RUNNING",
        "RUNNING",
        "RUNNING",
        "RUNNING",
        "IDLE",
      ),
    });
    const out = await run(
      "cloud-agent",
      showInput(BC_A, { wait: true, timeout: 600 }),
    );
    expect(out.outcome).toEqual({ status: "done" });
    expect(out.cloudAgent.status).toBe("finished");
    expect(sleeps).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
    expect(
      log.filter((c) => c.method === "GetBackgroundComposerConversation"),
    ).toHaveLength(1);
  });

  it.each([
    ["ERROR", "error"],
    ["EXPIRED", "expired"],
    ["ARCHIVED", "finished"],
  ])("treats %s as settled", async (name, status) => {
    const { run } = cloudAgentRunner({ composer: polling("RUNNING", name) });
    const out = await run("cloud-agent", showInput(BC_A, { wait: true }));
    expect([out.outcome, out.cloudAgent.status]).toEqual([
      { status: "done" },
      status,
    ]);
  });

  it("gives up when the timeout passes, reporting the last status and never sleeping past it", async () => {
    const { run, sleeps } = cloudAgentRunner({ composer: polling("RUNNING") });
    const out = await run(
      "cloud-agent",
      showInput(BC_A, { wait: true, timeout: 40 }),
    );
    expect(out.outcome).toEqual({
      status: "pending",
      reason: "still running after 40 s",
    });
    expect(out.cloudAgent.status).toBe("running");
    // 5 + 10 + 20 = 35 s, then only the 5 s that remain of the 40.
    expect(sleeps).toEqual([5000, 10000, 20000, 5000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(40_000);
  });

  it("still shows the messages when it times out", async () => {
    const { run } = cloudAgentRunner({ composer: polling("RUNNING") });
    const out = await run(
      "cloud-agent",
      showInput(BC_A, { wait: true, timeout: 5 }),
    );
    expect([out.outcome?.status, out.messages.length]).toEqual(["pending", 2]);
  });

  it("stops polling when aborted during a pause", async () => {
    const controller = new AbortController();
    const { run } = cloudAgentRunner({
      composer: polling("RUNNING"),
      sleep: async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      },
    });
    const error = await run("cloud-agent", showInput(BC_A, { wait: true }), {
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
  });

  it("does not poll without --wait, even for a running agent", async () => {
    const { run, sleeps, log } = cloudAgentRunner({
      composer: polling("RUNNING"),
    });
    const out = await run("cloud-agent", showInput(BC_A));
    expect([out.cloudAgent.status, out.outcome, sleeps]).toEqual([
      "running",
      undefined,
      [],
    ]);
    expect(
      log.filter((c) => c.method === "GetBackgroundComposerInfo"),
    ).toHaveLength(1);
  });
});

describe("BackgroundComposerService safety table", () => {
  const verdict = (method: string, confirmed: boolean) => {
    try {
      assertBackgroundComposerMethodAllowed(method, confirmed);
      return "allowed";
    } catch (error) {
      return error instanceof GrokBotError
        ? `${error.code}: ${error.message}`
        : "other";
    }
  };

  it.each([
    "GetBackgroundComposerInfo",
    "GetBackgroundComposerConversation",
    "StreamBackgroundComposerUpdates",
  ])("allows the read-only %s without confirmation", (method) => {
    expect(verdict(method, false)).toBe("allowed");
  });

  it.each([
    // Bearer download URLs, left out on purpose.
    "GetBackgroundComposerArtifact",
    "ListBackgroundComposerArtifacts",
    "ArchiveBackgroundComposer",
    "DeleteBackgroundComposer",
    "NotARealMethod",
    "constructor",
    "toString",
  ])("refuses %s unless the owner confirms", (method) => {
    expect(verdict(method, false)).toBe(
      `safety: ${method} is not in the safety catalog. Pass confirmed: true only after the owner approves.`,
    );
  });

  it("refuses a malformed method name even when confirmed", () => {
    expect(verdict("../GetBackgroundComposerInfo", true)).toBe(
      'safety: "../GetBackgroundComposerInfo" is not a valid method name.',
    );
  });

  it("keeps its methods apart from GrokBotService's table", () => {
    expect([
      // A cloud agent read is not a GrokBotService method, and the reverse.
      (() => {
        try {
          assertMethodAllowed("GetBackgroundComposerInfo", false);
          return "allowed";
        } catch {
          return "refused";
        }
      })(),
      verdict("ListGrokBotAgents", false),
    ]).toEqual([
      "refused",
      "safety: ListGrokBotAgents is not in the safety catalog. Pass confirmed: true only after the owner approves.",
    ]);
  });
});
