import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  listed,
  MANAGED_SKILL,
  methods,
  PLUGIN_SKILL,
  PROBE,
  PROBE_BOT,
  PUSHED_MARKDOWN,
  PUSHED_SKILL,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";
import { skillName } from "./workforce-skills.js";

const ROSTER = [{ agents: [...BASE_ROSTER, PROBE_BOT] }];
const LIBRARY = [PLUGIN_SKILL, MANAGED_SKILL, PUSHED_SKILL];
const PUSH = { agent: "GB Phase2 Probe", json: false };
const EDITED = PUSHED_MARKDOWN.replace("PROBE-OK", "PROBE-OK-2");
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;

async function skillFile(markdown = PUSHED_MARKDOWN): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "grokbot-skill-")), "probe");
  await mkdir(dir);
  const file = join(dir, "SKILL.md");
  await writeFile(file, markdown);
  return file;
}

const imported = (body: JsonObject) => ({
  workflows: [
    PLUGIN_SKILL,
    { ...PUSHED_SKILL, name: body.name, id: body.name },
  ],
  result: { imported: [{ id: body.name }] },
});

describe("skillName", () => {
  it("reads the frontmatter name, else the folder name, else nothing", () => {
    expect([
      skillName(PUSHED_MARKDOWN, "/x/probe/SKILL.md"),
      skillName('---\nname: "quoted"\n---\n', "/x/a/SKILL.md"),
      skillName("# no frontmatter\n", "/x/weekly-report/SKILL.md"),
      skillName("# no frontmatter\n", undefined),
    ]).toEqual(["gb-phase2-probe-skill", "quoted", "weekly-report", ""]);
  });
});

describe("skills-list", () => {
  it("lists the whole Box-wide library from a bare list or { workflows }, without bodies", async () => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: ROSTER },
      { getAgentWorkflows: [[PLUGIN_SKILL], { workflows: LIBRARY }] },
    );
    const first = await runner.run("skills-list", PUSH);
    const second = await runner.run("skills-list", PUSH);
    expect([
      first.skills,
      second.skills.map((s) => [s.id, s.managedBy]),
    ]).toEqual([
      [{ ...listed(PLUGIN_SKILL), managedBy: "user" }],
      [
        ["plugin:docs", "user"],
        ["add-connector", "grokbot"],
        ["gb-phase2-probe-skill", "user"],
      ],
    ]);
    expect(bodyOf(log, "getAgentWorkflows")).toEqual({ id: PROBE });
  });
});

describe("skills-push", () => {
  const push = async (
    gateway: Parameters<typeof workforceRunner>[1],
    fields: JsonObject,
  ) => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: ROSTER },
      gateway,
    );
    const out = await runner
      .run("skills-push", { ...PUSH, replace: false, yes: false, ...fields })
      .then((o): unknown => [o.result, o.skill], failure);
    return { out, calls: methods(log), log };
  };

  it("imports a file under its frontmatter name", async () => {
    const { out, log } = await push(
      {
        getAgentWorkflows: [[PLUGIN_SKILL]],
        importAgentWorkflowText: imported,
      },
      { file: await skillFile() },
    );
    expect(out).toEqual(["imported", listed(PUSHED_SKILL)]);
    expect(bodyOf(log, "importAgentWorkflowText")).toEqual({
      id: PROBE,
      markdown: PUSHED_MARKDOWN,
      name: "gb-phase2-probe-skill",
    });
  });

  it("imports markdown text given as content, named by --name", async () => {
    const { log } = await push(
      {
        getAgentWorkflows: [[PLUGIN_SKILL]],
        importAgentWorkflowText: imported,
      },
      { markdown: "Reply OK.", name: "renamed" },
    );
    expect(bodyOf(log, "importAgentWorkflowText")).toEqual({
      id: PROBE,
      markdown: "Reply OK.",
      name: "renamed",
    });
  });

  it("run again with the same content, writes nothing and succeeds", async () => {
    const { out, calls } = await push(
      { getAgentWorkflows: [LIBRARY] },
      { file: await skillFile() },
    );
    expect([out, calls]).toEqual([
      ["unchanged", listed(PUSHED_SKILL)],
      ["server:ListGrokBotAgents", "gateway:getAgentWorkflows"],
    ]);
  });

  it("refuses an edited file without --replace, naming the flags", async () => {
    const { out, calls } = await push(
      { getAgentWorkflows: [LIBRARY] },
      { file: await skillFile(EDITED) },
    );
    expect([out, calls]).toEqual([
      [
        "ambiguous",
        'The Box-wide (all bots) skill library already has a different "gb-phase2-probe-skill" (gb-phase2-probe-skill). Re-run with --replace --yes to replace it for every bot.',
      ],
      ["server:ListGrokBotAgents", "gateway:getAgentWorkflows"],
    ]);
  });

  it("with --replace --yes, deletes the imported copy (confirmed) and imports again", async () => {
    const { out, calls, log } = await push(
      {
        getAgentWorkflows: [LIBRARY],
        deleteAgentWorkflow: [[PLUGIN_SKILL, MANAGED_SKILL]],
        importAgentWorkflowText: imported,
      },
      { file: await skillFile(EDITED), replace: true, yes: true },
    );
    expect([out, calls]).toEqual([
      ["replaced", listed(PUSHED_SKILL)],
      [
        "server:ListGrokBotAgents",
        "gateway:getAgentWorkflows",
        "gateway:deleteAgentWorkflow",
        "gateway:importAgentWorkflowText",
      ],
    ]);
    expect(log[2]).toEqual({
      via: "gateway",
      method: "deleteAgentWorkflow",
      body: { id: PROBE, workflowId: "gb-phase2-probe-skill" },
      confirmed: true,
    });
  });

  it("with --replace and the same content, writes nothing", async () => {
    const { out, calls } = await push(
      { getAgentWorkflows: [LIBRARY] },
      { markdown: PUSHED_MARKDOWN, replace: true, yes: true },
    );
    expect([out, calls]).toEqual([
      ["unchanged", listed(PUSHED_SKILL)],
      ["server:ListGrokBotAgents", "gateway:getAgentWorkflows"],
    ]);
  });

  it("refuses --replace without --yes before any call", async () => {
    const { out, calls } = await push({}, { markdown: EDITED, replace: true });
    expect([out, calls]).toEqual([
      [
        "safety",
        "skills-push --replace first deletes the old copy for every bot. Re-run with --replace --yes.",
      ],
      [],
    ]);
  });

  it("refuses a name a managed skill already has, and suggests --name", async () => {
    const { out, calls } = await push(
      { getAgentWorkflows: [LIBRARY] },
      { markdown: "Connect things.", name: "Add-Connector" },
    );
    expect([out, calls]).toEqual([
      [
        "ambiguous",
        '"add-connector" (add-connector) is a managed skill in the Box-wide (all bots) skill library. Import yours under another name with --name.',
      ],
      ["server:ListGrokBotAgents", "gateway:getAgentWorkflows"],
    ]);
  });

  it("reports an existing imported skill whose body the list leaves out as exists", async () => {
    const { body: _drop, ...noBody } = PUSHED_SKILL;
    const { out } = await push(
      { getAgentWorkflows: [[noBody]] },
      { markdown: PUSHED_MARKDOWN },
    );
    expect(out).toEqual(["exists", listed(PUSHED_SKILL)]);
  });

  it("needs the skill text and a name, and says so before any call", async () => {
    const results = [
      await push({}, {}),
      await push({}, { markdown: "Reply OK." }),
      await push({}, { markdown: "x", file: "/tmp/SKILL.md" }),
    ];
    expect(results.map(({ out, calls }) => [out, calls])).toEqual([
      [
        [
          "not-found",
          "skills-push needs the skill text: a SKILL.md path, or markdown.",
        ],
        [],
      ],
      [
        [
          "not-found",
          'skills-push needs a name: add "name:" to the frontmatter, or pass --name.',
        ],
        [],
      ],
      [["not-found", "Pass a SKILL.md path or markdown, not both."], []],
    ]);
  });
});
