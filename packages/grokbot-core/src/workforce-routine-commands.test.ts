import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "./agents.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  type FakeExtras,
  memoryKeyStore,
  methods,
  PRIMARY,
  PROBE,
  PROBE_BOT,
  type Script,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";
import { routinesViaChat } from "./workforce-routine-chat.js";

/** A bot on the Cloud Box harness, whose routines go through the Box Gateway. */
const ROSTER = [{ agents: [...BASE_ROSTER, { ...PROBE_BOT, harness: "box" }] }];
const KEY = "synthetic-webhook-key-91c2";
const row = (automationId: string, fields: JsonObject) => ({
  automationId,
  recordJson: JSON.stringify({
    id: `${automationId}-record`,
    name: "Deploy hook",
    prompt: "Reply PONG.",
    trigger: { type: "webhook" },
    isEnabled: true,
    createdAt: 1000,
    ...fields,
  }),
});
const HOOK = row("auto-9", {});
const CRON = row("auto-1", {
  name: "Weekly report",
  trigger: { type: "cron", schedule: "0 9 * * 1" },
});
const FLAGS = {
  json: false,
  webhook: false,
  "require-auth-pass": false,
  timeout: 300,
  replace: false,
} as const;
const AGENT = { ...FLAGS, agent: "GB Phase2 Probe" };
const failure = (e: unknown): [string, string] =>
  e instanceof GrokBotError ? [e.code, e.message] : ["unexpected", String(e)];
const runner = (
  server: Script,
  gateway: Script = {},
  extras: FakeExtras = {},
) =>
  workforceRunner(
    { ListGrokBotAgents: ROSTER, ...server },
    gateway,
    mkdtempSync(join(tmpdir(), "grokbot-routines-")),
    extras,
  );

describe("routines-create with event triggers", () => {
  it("creates a webhook routine, switched off with --paused", async () => {
    const { runner: r, log } = runner(
      {
        ListGrokBotAgentAutomations: [
          { automations: [] },
          { automations: [HOOK] },
        ],
      },
      { createAgentAutomation: [[]] },
    );
    const out = await r.run("routines-create", {
      ...AGENT,
      name: "Deploy hook",
      prompt: "Reply PONG.",
      webhook: true,
      paused: true,
    });
    expect([out.result, out.routine.trigger, out.routine.id]).toEqual([
      "created",
      "webhook",
      "auto-9-record",
    ]);
    expect(bodyOf(log, "createAgentAutomation")).toEqual({
      id: PROBE,
      spec: {
        name: "Deploy hook",
        prompt: "Reply PONG.",
        trigger: { type: "webhook" },
        isEnabled: false,
      },
    });
  });

  it("needs a trigger and makes no call without one", async () => {
    const { runner: r, log } = runner({});
    const error = await r
      .run("routines-create", {
        ...AGENT,
        name: "x",
        prompt: "y",
        paused: false,
      })
      .catch(failure);
    expect(error).toEqual(["not-found", expect.any(String)]);
    expect(methods(log)).toEqual(["server:ListGrokBotAgents"]);
  });
});

describe("routines-update", () => {
  it("sends the whole spec with only the given fields changed, by record id", async () => {
    const renamed = row("auto-1", {
      name: "Monday report",
      trigger: { type: "cron", schedule: "0 9 * * 1" },
    });
    const { runner: r, log } = runner(
      {
        ListGrokBotAgentAutomations: [
          { automations: [CRON] },
          { automations: [renamed] },
        ],
      },
      { updateAgentAutomation: [[]] },
    );
    const out = await r.run("routines-update", {
      ...AGENT,
      routine: "Weekly report",
      name: "Monday report",
    });
    expect([out.changed, out.routine.name]).toEqual([
      ["name"],
      "Monday report",
    ]);
    expect(bodyOf(log, "updateAgentAutomation")).toEqual({
      id: PROBE,
      automationId: "auto-1-record",
      spec: {
        name: "Monday report",
        prompt: "Reply PONG.",
        trigger: { type: "cron", schedule: "0 9 * * 1" },
        isEnabled: true,
      },
    });
  });

  it("writes nothing when the values are already set", async () => {
    const { runner: r, log } = runner({
      ListGrokBotAgentAutomations: [{ automations: [CRON] }],
    });
    const out = await r.run("routines-update", {
      ...AGENT,
      routine: "auto-1",
      cron: "0 9 * * 1",
    });
    expect([out.changed, methods(log).at(-1)]).toEqual([
      [],
      "server:ListGrokBotAgentAutomations",
    ]);
  });

  it("refuses a protected bot without --force-protected", async () => {
    const { runner: r } = runner({});
    const error = await r
      .run("routines-update", {
        ...FLAGS,
        agent: "Primary Test",
        routine: "x",
        prompt: "y",
      })
      .catch(failure);
    expect(error).toEqual(["safety", expect.any(String)]);
  });
});

describe("routines-update through the gateway", () => {
  it("fails when the update returned but the routine did not change", async () => {
    const { runner: r } = runner(
      { ListGrokBotAgentAutomations: [{ automations: [CRON] }] },
      { updateAgentAutomation: [[]] },
    );
    const error = await r
      .run("routines-update", { ...AGENT, routine: "auto-1", prompt: "New." })
      .catch(failure);
    expect(error).toEqual([
      "protocol",
      "updateAgentAutomation returned, but Weekly report: its prompt differs.",
    ]);
  });
});

describe("routines-run on a bot on GrokBot's servers", () => {
  it("refuses before any gateway call", async () => {
    const { runner: r, log } = workforceRunner(
      {
        ListGrokBotAgents: [{ agents: [...BASE_ROSTER, PROBE_BOT] }],
        ListGrokBotAgentAutomations: [{ automations: [CRON] }],
      },
      {},
    );
    const error = await r
      .run("routines-run", { ...AGENT, routine: "auto-1" })
      .catch(failure);
    expect(error).toEqual([
      "not-found",
      expect.stringContaining("routines-fire"),
    ]);
    expect(methods(log).some((m) => m.startsWith("gateway:"))).toBe(false);
  });
});

describe("routines-run", () => {
  it("runs the routine through the gateway by record id", async () => {
    const { runner: r, log } = runner(
      { ListGrokBotAgentAutomations: [{ automations: [CRON] }] },
      { runAgentAutomationNow: [{}] },
    );
    await r.run("routines-run", { ...AGENT, routine: "Weekly report" });
    expect(bodyOf(log, "runAgentAutomationNow")).toEqual({
      id: PROBE,
      automationId: "auto-1-record",
    });
  });
});

describe("routines-delete", () => {
  it("removes the routine's webhook key from the Keychain first", async () => {
    const webhookKeys = memoryKeyStore();
    await webhookKeys.save(
      { agentId: PROBE, automationId: "auto-9", createdAt: 1000 },
      KEY,
    );
    const { runner: r } = runner(
      {
        ListGrokBotAgentAutomations: [{ automations: [HOOK] }],
        DeleteGrokBotAgentAutomation: [{}],
      },
      {},
      { webhookKeys },
    );
    const out = await r.run("routines-delete", {
      ...AGENT,
      routine: "Deploy hook",
      yes: true,
    });
    expect([out.webhookKeyRemoved, webhookKeys.keys.size]).toEqual([true, 0]);
  });
});

describe("routines-webhook-key", () => {
  const minting = (extras: FakeExtras = {}) =>
    runner(
      { ListGrokBotAgentAutomations: [{ automations: [HOOK, CRON] }] },
      {},
      {
        dashboard: { CreateAutomationWebhookApiKey: [{ apiKey: KEY }] },
        ...extras,
      },
    );
  const MINT = { ...AGENT, routine: "Deploy hook" };

  it("needs --yes before any call", async () => {
    const { runner: r, log } = minting();
    const error = await r
      .run("routines-webhook-key", { ...MINT, yes: false })
      .catch(failure);
    expect([error, log]).toEqual([["safety", expect.any(String)], []]);
  });

  it("mints once, confirmed, stores the key and never returns it", async () => {
    const webhookKeys = memoryKeyStore();
    const { runner: r, log } = minting({ webhookKeys });
    const out = await r.run("routines-webhook-key", { ...MINT, yes: true });
    expect(out.result).toBe("minted");
    expect(out.url).toBe("https://api2.cursor.sh/automations/webhook/auto-9");
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(log.at(-1)).toEqual({
      via: "dashboard",
      method: "CreateAutomationWebhookApiKey",
      body: { automationId: "auto-9" },
      confirmed: true,
    });
    expect(
      await webhookKeys.load({
        agentId: PROBE,
        automationId: "auto-9",
        createdAt: 1000,
      }),
    ).toBe(KEY);
    const again = await r.run("routines-webhook-key", { ...MINT, yes: true });
    expect([
      again.result,
      methods(log).filter((m) => m.startsWith("dashboard")),
    ]).toEqual(["exists", ["dashboard:CreateAutomationWebhookApiKey"]]);
  });

  it("mints a new key over a stored one only with replace", async () => {
    const webhookKeys = memoryKeyStore();
    const ref = { agentId: PROBE, automationId: "auto-9", createdAt: 1000 };
    await webhookKeys.save(ref, "old-key");
    const { runner: r } = minting({ webhookKeys });
    const out = await r.run("routines-webhook-key", {
      ...MINT,
      replace: true,
      yes: true,
    });
    expect([out.result, await webhookKeys.load(ref)]).toEqual([
      "replaced",
      KEY,
    ]);
  });

  it("refuses a routine that does not fire on a webhook", async () => {
    const { runner: r, log } = minting();
    const error = await r
      .run("routines-webhook-key", {
        ...MINT,
        routine: "Weekly report",
        yes: true,
      })
      .catch(failure);
    expect(error).toEqual([
      "not-found",
      "Weekly report fires on cron, not a webhook, so routines-webhook-key does not apply.",
    ]);
    expect(methods(log)).not.toContain(
      "dashboard:CreateAutomationWebhookApiKey",
    );
  });

  it("refuses a protected bot without --force-protected", async () => {
    const { runner: r } = minting();
    const error = await r
      .run("routines-webhook-key", { ...MINT, agent: PRIMARY, yes: true })
      .catch(failure);
    expect(error).toEqual(["safety", expect.any(String)]);
  });
});

describe("routines-fire", () => {
  const ref = { agentId: PROBE, automationId: "auto-9", createdAt: 1000 };

  it("POSTs the payload with the stored key", async () => {
    const webhookKeys = memoryKeyStore();
    await webhookKeys.save(ref, KEY);
    const used: string[] = [];
    const { runner: r, log } = runner(
      { ListGrokBotAgentAutomations: [{ automations: [HOOK] }] },
      {},
      {
        webhookKeys,
        webhook: (_url, key) => {
          used.push(key);
          return { status: 202, reply: { accepted: true } };
        },
      },
    );
    const out = await r.run("routines-fire", {
      ...AGENT,
      routine: "Deploy hook",
      payload: '{"build":42}',
    });
    expect([out.status, out.reply, used]).toEqual([
      202,
      { accepted: true },
      [KEY],
    ]);
    expect(log.at(-1)).toEqual({
      via: "webhook",
      method: "https://api2.cursor.sh/automations/webhook/auto-9",
      body: { build: 42 },
      confirmed: false,
    });
  });

  it("asks the owner to mint a key when none is stored for this routine", async () => {
    const webhookKeys = memoryKeyStore();
    await webhookKeys.save({ ...ref, createdAt: 999 }, KEY);
    const { runner: r, log } = runner(
      { ListGrokBotAgentAutomations: [{ automations: [HOOK] }] },
      {},
      { webhookKeys },
    );
    const error = await r
      .run("routines-fire", { ...AGENT, routine: "Deploy hook" })
      .catch(failure);
    expect(error).toEqual([
      "not-found",
      expect.stringContaining("routines-webhook-key"),
    ]);
    expect(methods(log)).not.toContainEqual(expect.stringMatching(/^webhook:/));
  });

  it("refuses a payload that is not a JSON object", async () => {
    const { runner: r } = runner({
      ListGrokBotAgentAutomations: [{ automations: [HOOK] }],
    });
    const error = await r
      .run("routines-fire", {
        ...AGENT,
        routine: "Deploy hook",
        payload: "[1]",
      })
      .catch(failure);
    expect(error).toEqual(["not-found", "The payload must be a JSON object."]);
  });
});

describe("routine review fixes", () => {
  it("routines-create refuses a protected bot without --force-protected", async () => {
    const { runner: r, log } = runner({});
    const error = await r
      .run("routines-create", {
        ...FLAGS,
        agent: "Primary Test",
        name: "Every five minutes",
        prompt: "Reply PONG.",
        cron: "*/5 * * * *",
        paused: false,
      })
      .catch(failure);
    expect(error).toEqual(["safety", expect.any(String)]);
    expect(methods(log)).not.toContain("server:SendGrokBotUserMessage");
  });

  it("refuses rooms and bots with no harness instead of using the Box Gateway", () => {
    const bot = (fields: object) =>
      ({
        kind: "agent",
        agentId: PROBE,
        rowId: "1",
        name: "Some bot",
        title: "",
        description: "",
        harness: "",
        ...fields,
      }) as Agent;
    const reason = (agent: Agent) => {
      try {
        return routinesViaChat(agent);
      } catch (e) {
        return failure(e)[0];
      }
    };
    expect([
      reason(bot({ harness: "temporal" })),
      reason(bot({ harness: "box" })),
      reason(bot({})),
      reason(bot({ kind: "room", memberAgentIds: [] })),
    ]).toEqual([true, false, "protocol", "not-found"]);
  });

  it("routines-delete deletes a non-webhook routine without touching the Keychain", async () => {
    const webhookKeys = {
      ...memoryKeyStore(),
      async remove(): Promise<boolean> {
        throw new Error("The keychain is locked.");
      },
    };
    const { runner: r } = runner(
      {
        ListGrokBotAgentAutomations: [{ automations: [CRON] }],
        DeleteGrokBotAgentAutomation: [{}],
      },
      {},
      { webhookKeys },
    );
    const out = await r.run("routines-delete", {
      ...AGENT,
      routine: "Weekly report",
      yes: true,
    });
    expect(out.webhookKeyRemoved).toBe(false);
  });

  it("routines-delete deletes on the server before removing the key, and says so when the Keychain fails", async () => {
    const webhookKeys = {
      ...memoryKeyStore(),
      async remove(): Promise<boolean> {
        throw new Error("The keychain is locked.");
      },
    };
    const { runner: r, log } = runner(
      {
        ListGrokBotAgentAutomations: [{ automations: [HOOK] }],
        DeleteGrokBotAgentAutomation: [{}],
      },
      {},
      { webhookKeys },
    );
    const error = await r
      .run("routines-delete", { ...AGENT, routine: "Deploy hook", yes: true })
      .catch(failure);
    expect([methods(log).at(-1), error]).toEqual([
      "server:DeleteGrokBotAgentAutomation",
      ["protocol", expect.stringContaining("Deleted routine Deploy hook")],
    ]);
  });
});
