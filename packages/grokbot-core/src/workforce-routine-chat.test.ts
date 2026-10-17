import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import {
  AGENT,
  botAfterSend,
  liveFrame,
  RUNNING,
  rowsFrame,
  TRACE_ROWS,
} from "./command-runner-test-bot.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { memoryKeyStore } from "./fixtures/workforce-fakes.js";
import { type JobStore, jobStore } from "./job-store.js";
import {
  routineDifferences,
  routineInstruction,
} from "./workforce-routine-chat.js";
import type { Routine } from "./workforce-routines.js";

const SPEC = {
  name: "Deploy hook",
  prompt: "Reply PONG.\nQuote the input.",
  trigger: { type: "github", repo: "o/r", events: ["ci-failed"] },
  isEnabled: false,
};
const SAVED: Routine = {
  automationId: "auto-9",
  id: "deploy-hook",
  name: "Deploy hook",
  prompt: "Reply PONG.\nQuote the input.",
  trigger: "github",
  triggerConfig: { events: ["ci-failed"], repo: "o/r", type: "github" },
  schedule: "",
  enabled: false,
  nextRunAt: null,
  createdAt: 1000,
};
const row = (fields: JsonObject = {}) => ({
  automationId: "auto-9",
  recordJson: JSON.stringify({
    id: "deploy-hook",
    name: SPEC.name,
    prompt: SPEC.prompt,
    trigger: SPEC.trigger,
    isEnabled: false,
    createdAt: 1000,
    ...fields,
  }),
});

describe("routineInstruction and routineDifferences", () => {
  it("asks for the exact spec, with the prompt between marker lines", () => {
    const text = routineInstruction(SPEC);
    expect(text).toContain("UpdateRoutine tool, exactly as below");
    expect(text).toContain("State: off (paused)");
    expect(text).toContain(`Trigger (JSON): ${JSON.stringify(SPEC.trigger)}`);
    expect(text).toContain(`<<<PROMPT\n${SPEC.prompt}\nPROMPT>>>`);
    expect(routineInstruction(SPEC, SAVED)).toContain(
      'Change your routine "Deploy hook" (id deploy-hook)',
    );
  });

  it("matches triggers whatever their key order, and names each difference", () => {
    expect(routineDifferences(SAVED, SPEC)).toEqual([]);
    expect(
      routineDifferences(
        { ...SAVED, prompt: "Something else", enabled: true },
        SPEC,
      ),
    ).toEqual(["its prompt differs", "it is on"]);
  });
});

describe("routines-create on a bot on GrokBot's servers", () => {
  let dir: string;
  let jobs: JobStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grokbot-routine-chat-"));
    jobs = jobStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const temporalBot = (saved: unknown) =>
    botAfterSend([], {
      calls: {
        ListGrokBotAgents: [
          {
            agents: [
              {
                id: "1",
                agentId: AGENT,
                name: "Trace Bot",
                kind: "GROK_BOT_AGENT_KIND_AGENT",
                harness: "temporal",
              },
            ],
          },
        ],
        ListGrokBotAgentStatuses: [RUNNING],
        ListGrokBotAgentAutomations: [
          { automations: [] },
          { automations: [saved] },
        ],
      },
      streams: [[rowsFrame([TRACE_ROWS.finalReply]), liveFrame()]],
    });
  const run = (server: ReturnType<typeof temporalBot>["server"]) =>
    createCommandRunner({
      server,
      jobs,
      webhookKeys: memoryKeyStore(),
      gateway: {
        call: async (method) => {
          throw new Error(`no gateway call expected: ${method}`);
        },
      },
    }).run("routines-create", {
      agent: "Trace Bot",
      name: SPEC.name,
      prompt: SPEC.prompt,
      github: "o/r",
      events: ["ci-failed"],
      paused: true,
      webhook: false,
      "require-auth-pass": false,
      timeout: 5,
      json: false,
    });

  it("asks the bot to save it, then returns the routine it saved", async () => {
    const { server, log } = temporalBot(row());
    const out = await run(server);
    expect([out.result, out.routine.automationId, typeof out.jobId]).toEqual([
      "created",
      "auto-9",
      "string",
    ]);
    const send = log.find(
      (c) => c.kind === "call" && c.method === "SendGrokBotUserMessage",
    );
    expect(JSON.stringify(send)).toContain("UpdateRoutine tool");
  });

  it("fails when the saved routine differs from what was asked", async () => {
    const { server } = temporalBot(row({ prompt: "Reply PONG." }));
    const error = await run(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).toContain("its prompt differs");
  });
});
