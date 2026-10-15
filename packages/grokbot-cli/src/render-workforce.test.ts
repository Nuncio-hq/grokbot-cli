import { describe, expect, it } from "vitest";
import { PRIMARY, ROOM, STAFF } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const SKILL = {
  id: "gb-phase2-probe-skill",
  name: "gb-phase2-probe-skill",
  source: "workflow",
  description: "Probe",
};
const ROUTINE = {
  automationId: "auto-1",
  name: "Weekly report",
  prompt: "Write it.",
  trigger: "cron",
  schedule: "0 9 * * 1",
  enabled: true,
  nextRunAt: "2026-10-19T22:30:00.000Z",
};

describe("workforce commands on the CLI", () => {
  it("hire parses flags and the positional name, and prints the folder", async () => {
    const run = await runCli(
      ["hire", "GB Phase2 Probe", "--title", "Probe", "--description", "Temp"],
      {
        outputs: {
          hire: {
            agent: { ...PRIMARY, title: "Probe" },
            folder: "/workspace/staff/gb-phase2-probe/",
            result: "created",
          },
        },
      },
    );
    expect(run.calls.map((c) => [c.name, c.input])).toEqual([
      [
        "hire",
        {
          name: "GB Phase2 Probe",
          title: "Probe",
          description: "Temp",
          json: false,
        },
      ],
    ]);
    expect(run).toMatchObject({
      stdout:
        "Hired Primary Test (f882ec52) as Probe. Folder: /workspace/staff/gb-phase2-probe/\n",
      code: 0,
    });
  });

  it("room-create takes repeated --member flags as one list", async () => {
    const run = await runCli(
      [
        "room-create",
        "GB Room",
        "--member",
        "Primary Test",
        "--member",
        "Staff Test",
      ],
      {
        outputs: {
          "room-create": {
            room: ROOM,
            members: [PRIMARY, STAFF],
            result: "created",
          },
        },
      },
    );
    expect(run.calls[0]?.input).toEqual({
      name: "GB Room",
      member: ["Primary Test", "Staff Test"],
      json: false,
    });
    expect(run.stdout).toBe(
      "Created room GB Test Room (7c0d1e2f) with Primary Test, Staff Test.\n",
    );
  });

  it("fire without --yes stops at the runner's safety error with exit 1", async () => {
    const { GrokBotError } = await import("grokbot-core");
    const run = await runCli(["fire", "GB Phase2 Probe"], {
      error: new GrokBotError(
        "safety",
        "fire changes or deletes live data. Re-run with --yes.",
      ),
    });
    expect([run.calls[0]?.input, run.stderr, run.code]).toEqual([
      { agent: "GB Phase2 Probe", yes: false, json: false },
      "grokbot: fire changes or deletes live data. Re-run with --yes.\n",
      1,
    ]);
  });

  it("--force-protected takes the bot's agentId as its value", async () => {
    const run = await runCli(
      ["fire", "Staff Test", "--force-protected", STAFF.agentId, "--yes"],
      { outputs: { fire: { agent: STAFF } } },
    );
    expect([run.calls[0]?.input, run.stdout]).toEqual([
      {
        agent: "Staff Test",
        "force-protected": STAFF.agentId,
        yes: true,
        json: false,
      },
      `Fired Staff Test (${STAFF.agentId.slice(0, 8)}).\n`,
    ]);
  });

  it("skills-list and skills-push say the library is Box-wide", async () => {
    const list = await runCli(["skills-list", "Primary Test"], {
      outputs: { "skills-list": { agent: PRIMARY, skills: [SKILL] } },
    });
    const pushed = await Promise.all(
      (["imported", "unchanged", "exists", "replaced"] as const).map((result) =>
        runCli(["skills-push", "Primary Test", "/tmp/SKILL.md"], {
          outputs: { "skills-push": { agent: PRIMARY, skill: SKILL, result } },
        }),
      ),
    );
    expect([list.stdout, ...pushed.map((p) => p.stdout)]).toEqual([
      "Box-wide (all bots) skill library, read through Primary Test:\n" +
        "NAME                   SOURCE    ID\ngb-phase2-probe-skill  workflow  gb-phase2-probe-skill\n",
      "Imported skill gb-phase2-probe-skill (gb-phase2-probe-skill) into the Box-wide (all bots) skill library.\n",
      "The Box-wide (all bots) skill library already has gb-phase2-probe-skill (gb-phase2-probe-skill) with this content; nothing imported.\n",
      "The Box-wide (all bots) skill library already has gb-phase2-probe-skill (gb-phase2-probe-skill); its content could not be compared, so nothing was imported. Add --replace --yes to import this file over it.\n",
      "Replaced skill gb-phase2-probe-skill (gb-phase2-probe-skill) in the Box-wide (all bots) skill library.\n",
    ]);
  });

  it("skills-push reads the file the CLI names and passes its text as markdown", async () => {
    const run = await runCli(
      ["skills-push", "Primary Test", "/tmp/SKILL.md", "--replace", "--yes"],
      {
        outputs: {
          "skills-push": { agent: PRIMARY, skill: SKILL, result: "replaced" },
        },
      },
    );
    expect(run.calls[0]?.input).toEqual({
      agent: "Primary Test",
      file: "/tmp/SKILL.md",
      replace: true,
      yes: true,
      json: false,
    });
  });

  it("routines-list and routines-disable show state and next run", async () => {
    const list = await runCli(["routines-list", "Primary Test"], {
      outputs: { "routines-list": { agent: PRIMARY, routines: [ROUTINE] } },
    });
    const off = await runCli(["routines-disable", "Primary Test", "auto-1"], {
      outputs: {
        "routines-disable": {
          agent: PRIMARY,
          routine: { ...ROUTINE, enabled: false, nextRunAt: null },
        },
      },
    });
    expect([list.stdout, off.stdout]).toEqual([
      "NAME           ID      STATE  TRIGGER    NEXT RUN\n" +
        "Weekly report  auto-1  on     0 9 * * 1  2026-10-19T22:30:00.000Z\n",
      "Turned off routine Weekly report (auto-1) for Primary Test. Paused.\n",
    ]);
  });
});
