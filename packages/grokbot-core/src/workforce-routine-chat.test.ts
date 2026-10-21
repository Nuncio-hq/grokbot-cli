import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { CommandRunnerOptions } from "./command-runner-contract.js";
import {
  AGENT,
  botAfterSend,
  liveFrame,
  RUNNING,
  rowsFrame,
  TRACE_ROWS,
} from "./command-runner-test-bot.js";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import type { RecordedCall } from "./fixtures/fake-server.js";
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
const sentTexts = (log: readonly RecordedCall[]) =>
  log
    .filter((c) => c.kind === "call" && c.method === "SendGrokBotUserMessage")
    .map((c) => String(c.body.text));

describe("routineInstruction", () => {
  it("asks for the exact spec, with the prompt between marker lines", () => {
    const text = routineInstruction(SPEC);
    expect(text).toContain("UpdateRoutine");
    expect(text).toContain("State: off (paused)");
    expect(text).toContain(`Trigger (JSON): ${JSON.stringify(SPEC.trigger)}`);
    expect(text).toContain(`<<<PROMPT\n${SPEC.prompt}\nPROMPT>>>`);
  });

  it("names the routine to change by its id, and only for a change", () => {
    expect(routineInstruction(SPEC)).not.toContain(SAVED.id);
    expect(routineInstruction(SPEC, SAVED)).toContain(SAVED.id);
  });
});

describe("routineDifferences", () => {
  it("is empty when the routine matches, whatever the trigger's key order", () => {
    expect(routineDifferences(SAVED, SPEC)).toEqual([]);
  });

  it.each([
    ["prompt", { prompt: "Something else" }, "prompt"],
    ["name", { name: "Other name" }, "Other name"],
    [
      "trigger",
      { triggerConfig: { type: "webhook" } },
      JSON.stringify({ type: "webhook" }),
    ],
    ["state", { enabled: true }, undefined],
  ] as const)(
    "reports a different %s on its own",
    (_field, change, mention) => {
      const differences = routineDifferences({ ...SAVED, ...change }, SPEC);
      expect(differences).toHaveLength(1);
      if (mention !== undefined) expect(differences[0]).toContain(mention);
    },
  );

  it("reports every field that differs", () => {
    expect(
      routineDifferences(
        { ...SAVED, prompt: "Something else", enabled: true },
        SPEC,
      ),
    ).toHaveLength(2);
  });
});

describe("routines-create and routines-update through the bot's chat", () => {
  let dir: string;
  let jobs: JobStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "grokbot-routine-chat-"));
    jobs = jobStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A bot that replies at once; each listing is what one read of its routines returns. */
  const botWith = (...listings: readonly (readonly unknown[])[]) =>
    botAfterSend([], {
      calls: {
        ListGrokBotAgentStatuses: [RUNNING],
        ListGrokBotAgentAutomations: listings.map((automations) => ({
          automations,
        })),
      },
      streams: [[rowsFrame([TRACE_ROWS.finalReply]), liveFrame()]],
    });
  const runner = (
    server: ServerTransport,
    options: CommandRunnerOptions = {},
  ) =>
    createCommandRunner({
      server,
      jobs,
      webhookKeys: memoryKeyStore(),
      ...options,
    });
  const FLAGS = {
    agent: "Trace Bot",
    webhook: false,
    "require-auth-pass": false,
    timeout: 5,
    json: false,
  } as const;
  const create = (server: ServerTransport, options?: CommandRunnerOptions) =>
    runner(server, options).run("routines-create", {
      ...FLAGS,
      name: SPEC.name,
      prompt: SPEC.prompt,
      github: "o/r",
      events: ["ci-failed"],
      paused: true,
    });
  const rename = (server: ServerTransport) =>
    runner(server).run("routines-update", {
      ...FLAGS,
      routine: SPEC.name,
      name: "Monday hook",
    });

  it("create asks the bot to save it, then returns the routine it saved", async () => {
    const { server, log } = botWith([], [row()]);
    const out = await create(server);
    expect([out.result, out.routine.automationId, typeof out.jobId]).toEqual([
      "created",
      "auto-9",
      "string",
    ]);
    const [text] = sentTexts(log);
    expect(text).toContain("State: off (paused)");
    expect(text).toContain(`<<<PROMPT\n${SPEC.prompt}\nPROMPT>>>`);
  });

  it("sends the instruction as it is, without the project and runtime tag", async () => {
    const { server, log } = botWith([], [row()]);
    await create(server, {
      caller: "omp",
      cwd: dir,
      projectRoutes: async () =>
        new Map([[dir, { agentId: AGENT, label: "Proj" }]]),
    });
    const sent = sentTexts(log);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/^\[/);
  });

  it("create fails when the saved routine differs from what was asked", async () => {
    const { server } = botWith([], [row({ prompt: "Reply PONG." })]);
    const error = await create(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).code).toBe("protocol");
    expect((error as GrokBotError).message).toContain("prompt");
  });

  it("create fails when the bot's turn ended without saving the routine", async () => {
    const { server } = botWith([], []);
    const error = await create(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).code).toBe("protocol");
  });

  it("update asks the bot to change the routine by id and returns what it saved", async () => {
    const { server, log } = botWith([row()], [row({ name: "Monday hook" })]);
    const out = await rename(server);
    expect([out.changed, out.routine.name]).toEqual([["name"], "Monday hook"]);
    const [text] = sentTexts(log);
    expect(text).toContain(SAVED.id);
    expect(text).toContain("Monday hook");
    // Fields that were not asked to change go out as they are.
    expect(text).toContain("State: off (paused)");
    expect(text).toContain(`<<<PROMPT\n${SPEC.prompt}\nPROMPT>>>`);
    expect(text).toContain(`Trigger (JSON): ${JSON.stringify(SPEC.trigger)}`);
  });

  it("update fails when the bot's save left the routine unchanged", async () => {
    const { server } = botWith([row()], [row()]);
    const error = await rename(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).code).toBe("protocol");
    expect((error as GrokBotError).message).toContain("name");
  });
});
