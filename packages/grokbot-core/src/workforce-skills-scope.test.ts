import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  listed,
  MANAGED_SKILL,
  methods,
  PLUGIN_SKILL,
  PROBE,
  PROBE_BOT,
  PUSHED_SKILL,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const ROSTER = [{ agents: [...BASE_ROSTER, PROBE_BOT] }];
const LIBRARY = [PLUGIN_SKILL, MANAGED_SKILL, PUSHED_SKILL];
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;
const BUILT_IN_HINT =
  'No imported skill "add-connector" in the Box-wide (all bots) skill library. add-connector is a managed skill; pass --include-managed (grokbot CLI only) to act on it.';

describe("skills-remove acts on imported skills only", () => {
  const remove = async (skill: string, includeManaged = false) => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: ROSTER },
      {
        getAgentWorkflows: [LIBRARY],
        deleteAgentWorkflow: [[PLUGIN_SKILL, PUSHED_SKILL]],
      },
    );
    const out = await runner
      .run("skills-remove", {
        agent: "GB Phase2 Probe",
        skill,
        yes: true,
        json: false,
        "include-managed": includeManaged,
      })
      .then((o) => [o.skill, o.remaining], failure);
    return [out, methods(log), bodyOf(log, "deleteAgentWorkflow")];
  };

  it("deletes an imported skill by name", async () => {
    expect(await remove("GB-Phase2-Probe-Skill")).toEqual([
      [listed(PUSHED_SKILL), 2],
      [
        "server:ListGrokBotAgents",
        "gateway:getAgentWorkflows",
        "gateway:deleteAgentWorkflow",
      ],
      { id: PROBE, workflowId: "gb-phase2-probe-skill" },
    ]);
  });

  it("refuses a managed skill, naming --include-managed, before deleting", async () => {
    const [out, calls] = await remove("add-connector");
    expect([out, calls]).toEqual([
      ["not-found", BUILT_IN_HINT],
      ["server:ListGrokBotAgents", "gateway:getAgentWorkflows"],
    ]);
  });

  it("deletes a managed skill with --include-managed", async () => {
    const [out, , body] = await remove("add-connector", true);
    expect([out, body]).toEqual([
      [listed(MANAGED_SKILL), 2],
      { id: PROBE, workflowId: "add-connector" },
    ]);
  });

  it("names the skills-list command when nothing matches", async () => {
    const [out] = await remove("nope");
    expect(out).toEqual([
      "not-found",
      'No imported skill "nope" in the Box-wide (all bots) skill library. List them with grokbot skills-list.',
    ]);
  });
});

describe("skills-run acts on imported skills only", () => {
  const run = async (skill: string, includeManaged = false) => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: ROSTER },
      { getAgentWorkflows: [LIBRARY], runAgentWorkflowNow: [{}] },
    );
    const out = await runner
      .run("skills-run", {
        agent: "GB Phase2 Probe",
        skill,
        json: false,
        "include-managed": includeManaged,
      })
      .then((o) => o.skill.id, failure);
    return [out, bodyOf(log, "runAgentWorkflowNow")];
  };

  it("starts an imported skill by its id, and a managed one only with --include-managed", async () => {
    expect([
      await run("gb-phase2-probe-skill"),
      await run("add-connector"),
      await run("add-connector", true),
    ]).toEqual([
      [
        "gb-phase2-probe-skill",
        { id: PROBE, workflowId: "gb-phase2-probe-skill" },
      ],
      [["not-found", BUILT_IN_HINT], undefined],
      ["add-connector", { id: PROBE, workflowId: "add-connector" }],
    ]);
  });
});
