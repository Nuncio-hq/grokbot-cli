import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  methods,
  PROBE,
  PROBE_BOT,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const ROSTER = [{ agents: [...BASE_ROSTER, PROBE_BOT] }];
const record = (fields: JsonObject) =>
  JSON.stringify({
    id: "weekly-report",
    name: "Weekly report",
    prompt: "Write the weekly report.",
    trigger: { type: "cron", schedule: "CRON_TZ=Australia/Adelaide 0 9 * * 1" },
    isEnabled: true,
    nextRunAt: "2026-10-19T22:30:00.000Z",
    ...fields,
  });
const WEEKLY = { automationId: "auto-1", recordJson: record({}) };
const PAUSED = {
  automationId: "auto-1",
  recordJson: record({ isEnabled: false, nextRunAt: null }),
};
const ROUTINE = {
  automationId: "auto-1",
  name: "Weekly report",
  prompt: "Write the weekly report.",
  trigger: "cron",
  schedule: "CRON_TZ=Australia/Adelaide 0 9 * * 1",
  enabled: true,
  nextRunAt: "2026-10-19T22:30:00.000Z",
};
const AGENT = { agent: "GB Phase2 Probe", json: false };
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;

describe("routines-list", () => {
  it("parses each routine's recordJson", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: ROSTER,
      ListGrokBotAgentAutomations: [{ automations: [WEEKLY] }],
    });
    const out = await runner.run("routines-list", AGENT);
    expect(out.routines).toEqual([ROUTINE]);
    expect(bodyOf(log, "ListGrokBotAgentAutomations")).toEqual({
      agentId: PROBE,
    });
  });

  it("fails on a recordJson that is not JSON", async () => {
    const { runner } = workforceRunner({
      ListGrokBotAgents: ROSTER,
      ListGrokBotAgentAutomations: [
        { automations: [{ automationId: "a", recordJson: "{" }] },
      ],
    });
    expect(await runner.run("routines-list", AGENT).catch(failure)).toEqual([
      "protocol",
      "ListGrokBotAgentAutomations: recordJson is not a JSON object",
    ]);
  });
});

describe("routines-enable and routines-disable", () => {
  it("turn a routine off by name and back on by id", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: ROSTER,
      ListGrokBotAgentAutomations: [{ automations: [WEEKLY] }],
      SetGrokBotAgentAutomationEnabled: [
        { automations: [PAUSED] },
        { automations: [WEEKLY] },
      ],
    });
    const off = await runner.run("routines-disable", {
      ...AGENT,
      routine: "weekly report",
    });
    const on = await runner.run("routines-enable", {
      ...AGENT,
      routine: "auto-1",
    });
    expect([
      off.routine.enabled,
      off.routine.nextRunAt,
      on.routine.enabled,
    ]).toEqual([false, null, true]);
    expect(
      log
        .filter((c) => c.method === "SetGrokBotAgentAutomationEnabled")
        .map((c) => c.body),
    ).toEqual([
      { agentId: PROBE, automationId: "auto-1", isEnabled: false },
      { agentId: PROBE, automationId: "auto-1", isEnabled: true },
    ]);
  });

  it("treat a reply without a list as success and read the routine back", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: ROSTER,
      ListGrokBotAgentAutomations: [
        { automations: [WEEKLY] },
        { automations: [PAUSED] },
      ],
      SetGrokBotAgentAutomationEnabled: [{}],
    });
    const off = await runner.run("routines-disable", {
      ...AGENT,
      routine: "Weekly report",
    });
    expect([off.routine.enabled, methods(log)]).toEqual([
      false,
      [
        "server:ListGrokBotAgents",
        "server:ListGrokBotAgentAutomations",
        "server:SetGrokBotAgentAutomationEnabled",
        "server:ListGrokBotAgentAutomations",
      ],
    ]);
  });
});

describe("routines-delete", () => {
  it("deletes the routine, confirmed, and reports how many are left", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: ROSTER,
      ListGrokBotAgentAutomations: [{ automations: [WEEKLY] }],
      DeleteGrokBotAgentAutomation: [{}],
    });
    const out = await runner.run("routines-delete", {
      ...AGENT,
      routine: "Weekly report",
      yes: true,
    });
    expect([out.routine.automationId, out.remaining]).toEqual(["auto-1", 0]);
    expect(log.at(-1)).toEqual({
      via: "server",
      method: "DeleteGrokBotAgentAutomation",
      body: { agentId: PROBE, automationId: "auto-1" },
      confirmed: true,
    });
  });
});

describe("routines-create", () => {
  const CREATE = {
    ...AGENT,
    name: "Weekly report",
    cron: "CRON_TZ=Australia/Adelaide 0 9 * * 1",
    prompt: "Write the weekly report.",
  };

  it("sends a cron spec through the gateway and returns the routine the server lists", async () => {
    const { runner, log } = workforceRunner(
      {
        ListGrokBotAgents: ROSTER,
        ListGrokBotAgentAutomations: [
          { automations: [] },
          { automations: [WEEKLY] },
        ],
      },
      { createAgentAutomation: [[]] },
    );
    const out = await runner.run("routines-create", CREATE);
    expect([out.result, out.routine]).toEqual(["created", ROUTINE]);
    expect(bodyOf(log, "createAgentAutomation")).toEqual({
      id: PROBE,
      spec: {
        name: "Weekly report",
        prompt: "Write the weekly report.",
        trigger: {
          type: "cron",
          schedule: "CRON_TZ=Australia/Adelaide 0 9 * * 1",
        },
        isEnabled: true,
      },
    });
  });

  it("run again, finds the routine by name and creates nothing", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: ROSTER,
      ListGrokBotAgentAutomations: [{ automations: [WEEKLY] }],
    });
    const out = await runner.run("routines-create", CREATE);
    expect([out.result, methods(log)]).toEqual([
      "exists",
      ["server:ListGrokBotAgents", "server:ListGrokBotAgentAutomations"],
    ]);
  });
});
