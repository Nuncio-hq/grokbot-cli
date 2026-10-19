import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  MAIN,
  methods,
  PRIMARY,
  STAFF,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const ROSTER = [{ agents: BASE_ROSTER }];
const WEEKLY = {
  automationId: "auto-1",
  recordJson: JSON.stringify({ name: "Weekly", isEnabled: true }),
};
const IMPORTED = {
  id: "gb-skill",
  name: "gb-skill",
  source: "workflow",
  description: "",
  body: "Hi",
};
const SERVER = {
  ListGrokBotAgents: ROSTER,
  ListGrokBotAgentAutomations: [{ automations: [WEEKLY] }],
  SetGrokBotAgentAutomationEnabled: [{ automations: [WEEKLY] }],
  DeleteGrokBotAgentAutomation: [{ automations: [] }],
  DeleteGrokBotAgent: [{}],
};
const GATEWAY = {
  getAgentWorkflows: [[IMPORTED]],
  deleteAgentWorkflow: [[]],
};
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;
const refusal = (name: string, id: string, command: string) => [
  "safety",
  `${name} (${id.slice(0, 8)}) is protected, so ${command} refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
];

/** Runs one command on Staff Test; returns its error (or "ok") and the calls it made. */
async function onStaffTest(command: string, fields: JsonObject) {
  const { runner, log } = workforceRunner(SERVER, GATEWAY);
  const input = { agent: "Staff Test", json: false, ...fields };
  const outcome = await runner
    .run(command as "fire", input as never)
    .then(() => "ok", failure);
  return [outcome, methods(log)];
}

describe("fire on a protected bot", () => {
  it.each([
    ["no value", undefined],
    ["the word true", "true"],
    ["an 8-char prefix", MAIN.slice(0, 8)],
    ["another protected bot's id", PRIMARY],
  ])("refuses Grok Bot given %s, before deleting", async (_label, force) => {
    const { runner, log } = workforceRunner({ ListGrokBotAgents: ROSTER });
    const error = await runner
      .run("fire", {
        agent: "Grok Bot",
        yes: true,
        json: false,
        ...(force !== undefined && { "force-protected": force }),
      })
      .catch(failure);
    expect([error, methods(log)]).toEqual([
      refusal("Grok Bot", MAIN, "fire"),
      ["server:ListGrokBotAgents"],
    ]);
  });

  it("deletes Staff Test when --force-protected is its full agentId, in any case", async () => {
    const { runner, log } = workforceRunner(SERVER);
    await runner.run("fire", {
      agent: "Staff Test",
      "force-protected": ` ${STAFF.toUpperCase()} `,
      yes: true,
      json: false,
    });
    expect(bodyOf(log, "DeleteGrokBotAgent")).toEqual({ id: STAFF });
  });
});

describe("the protected list is the user's", () => {
  it("leaves a bot alone that the list does not name", async () => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: ROSTER, DeleteGrokBotAgent: [{}] },
      {},
      undefined,
      { protectedBots: async () => new Map() },
    );
    await runner.run("fire", { agent: "Grok Bot", yes: true, json: false });
    expect(methods(log)).toEqual([
      "server:ListGrokBotAgents",
      "server:DeleteGrokBotAgent",
    ]);
  });

  it("refuses to fire anything when the list cannot be read", async () => {
    const broken = new GrokBotError("safety", "list is not valid JSON");
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: ROSTER, DeleteGrokBotAgent: [{}] },
      {},
      undefined,
      {
        protectedBots: async () => {
          throw broken;
        },
      },
    );
    const error = await runner
      .run("fire", { agent: "Staff Test", yes: true, json: false })
      .catch((e: unknown) => e);
    expect([error, methods(log)]).toEqual([
      broken,
      ["server:ListGrokBotAgents"],
    ]);
  });
});

describe("skills-remove and routine writes on a protected bot", () => {
  it.each([
    [
      "skills-remove",
      { skill: "gb-skill", yes: true },
      ["gateway:getAgentWorkflows", "gateway:deleteAgentWorkflow"],
    ],
    [
      "routines-delete",
      { routine: "Weekly", yes: true },
      [
        "server:ListGrokBotAgentAutomations",
        "server:DeleteGrokBotAgentAutomation",
      ],
    ],
    [
      "routines-enable",
      { routine: "Weekly" },
      [
        "server:ListGrokBotAgentAutomations",
        "server:SetGrokBotAgentAutomationEnabled",
      ],
    ],
    [
      "routines-disable",
      { routine: "Weekly" },
      [
        "server:ListGrokBotAgentAutomations",
        "server:SetGrokBotAgentAutomationEnabled",
      ],
    ],
  ] as const)(
    "%s refuses Staff Test unless --force-protected is its agentId",
    async (command, fields, writes) => {
      expect([
        await onStaffTest(command, fields),
        await onStaffTest(command, { ...fields, "force-protected": PRIMARY }),
        await onStaffTest(command, { ...fields, "force-protected": STAFF }),
      ]).toEqual([
        [refusal("Staff Test", STAFF, command), ["server:ListGrokBotAgents"]],
        [refusal("Staff Test", STAFF, command), ["server:ListGrokBotAgents"]],
        ["ok", ["server:ListGrokBotAgents", ...writes]],
      ]);
    },
  );
});
