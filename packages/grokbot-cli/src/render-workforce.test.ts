import { describe, expect, it } from "vitest";
import { PRIMARY, ROOM, STAFF } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

const SKILL = {
  id: "gb-phase2-probe-skill",
  name: "gb-phase2-probe-skill",
  source: "workflow",
  description: "Probe",
};
const BUILT_IN = {
  id: "add-connector",
  name: "add-connector",
  source: "managed",
  description: "Connect an MCP server",
  managedBy: "grokbot" as const,
};
const ROUTINE = {
  automationId: "auto-1",
  id: "weekly-report",
  name: "Weekly report",
  prompt: "Write it.",
  trigger: "cron",
  triggerConfig: { type: "cron", schedule: "0 9 * * 1" },
  schedule: "0 9 * * 1",
  enabled: true,
  nextRunAt: "2026-10-19T22:30:00.000Z",
  createdAt: 1000,
};
const HOOK = {
  ...ROUTINE,
  automationId: "auto-9",
  name: "Deploy hook",
  trigger: "webhook",
  triggerConfig: { type: "webhook" },
  schedule: "",
};
const KEY_ITEM = { service: "grokbot-cli-webhook", account: "ab12" };
const HOOK_URL = "https://api2.cursor.sh/automations/webhook/auto-9";

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
      outputs: {
        "skills-list": {
          agent: PRIMARY,
          skills: [{ ...SKILL, managedBy: "user" }, BUILT_IN],
        },
      },
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
        "NAME                   TYPE             SOURCE    ID\n" +
        "add-connector          grokbot-managed  managed   add-connector\n" +
        "gb-phase2-probe-skill  user-managed     workflow  gb-phase2-probe-skill\n" +
        "1 grokbot-managed (built into GrokBot), 1 user-managed (from this account's connectors and its own imports).\n",
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

  it("files shows both sections with human sizes, and files-remove parses its positional path and --section", async () => {
    const team = { totalBytes: 2048, canEdit: true, complete: true };
    const brief = {
      section: "team" as const,
      name: "brief.md",
      path: "files/brief.md",
      sizeBytes: 2048,
      updatedAt: "2026-10-19T08:00:00.000Z",
    };
    const mine = {
      section: "only-you" as const,
      name: "todo.txt",
      path: "notes/todo.txt",
      sizeBytes: 10,
      updatedAt: null,
    };
    const list = await runCli(["files", "Primary Test"], {
      outputs: { files: { agent: PRIMARY, files: [brief, mine], team } },
    });
    const empty = await runCli(["files", "Primary Test"], {
      outputs: { files: { agent: PRIMARY, files: [], team } },
    });
    const cut = await runCli(["files", "Primary Test"], {
      outputs: {
        files: {
          agent: PRIMARY,
          files: [brief],
          team: { ...team, canEdit: false, complete: false },
        },
      },
    });
    const removed = await runCli(
      [
        "files-remove",
        "Primary Test",
        "notes/todo.txt",
        "--section",
        "only-you",
        "--yes",
      ],
      { outputs: { "files-remove": { agent: PRIMARY, file: mine } } },
    );
    expect([
      list.stdout,
      empty.stdout,
      cut.stdout.split("\n").at(-2),
      removed.calls[0]?.input,
      removed.stdout,
    ]).toEqual([
      "Files of Primary Test:\n" +
        "SECTION   NAME      PATH            SIZE    UPDATED\n" +
        "team      brief.md  files/brief.md  2.0 KB  2026-10-19T08:00:00.000Z\n" +
        "only-you  todo.txt  notes/todo.txt  10 B    -\n" +
        "Team files: 2.0 KB used; you can edit them.\n",
      "Primary Test has no files.\n",
      "Team files: 2.0 KB used; you cannot edit them. The team listing is cut short; more files exist.",
      {
        agent: "Primary Test",
        path: "notes/todo.txt",
        section: "only-you",
        yes: true,
        json: false,
      },
      "Removed only-you file notes/todo.txt from Primary Test; it can no longer read it.\n",
    ]);
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

  it("routines-create passes every trigger flag through", async () => {
    const run = await runCli(
      [
        "routines-create",
        "Primary Test",
        "--name",
        "CI watch",
        "--prompt",
        "Say why CI failed.",
        "--github",
        "owner/repo",
        "--events",
        "ci-failed,pr-opened",
        "--ci-branch",
        "main",
        "--paused",
      ],
      {
        outputs: {
          "routines-create": {
            agent: PRIMARY,
            routine: { ...ROUTINE, enabled: false },
            result: "created",
          },
        },
      },
    );
    expect(run.calls[0]?.input).toMatchObject({
      agent: "Primary Test",
      name: "CI watch",
      github: "owner/repo",
      events: ["ci-failed", "pr-opened"],
      "ci-branch": "main",
      paused: true,
      webhook: false,
    });
  });

  it("routines-webhook-key and routines-fire name the URL and never a key", async () => {
    const key = await runCli(
      ["routines-webhook-key", "Primary Test", "Deploy hook", "--yes"],
      {
        outputs: {
          "routines-webhook-key": {
            agent: PRIMARY,
            routine: HOOK,
            url: HOOK_URL,
            keychainItem: KEY_ITEM,
            result: "minted",
          },
        },
      },
    );
    const fire = await runCli(
      ["routines-fire", "Primary Test", "Deploy hook", "--payload", "{}"],
      {
        outputs: {
          "routines-fire": {
            agent: PRIMARY,
            routine: HOOK,
            url: HOOK_URL,
            status: 202,
            reply: { ok: true },
          },
        },
      },
    );
    expect([key.stdout, fire.stdout]).toEqual([
      "Minted the webhook key for routine Deploy hook and stored it in the Keychain (service grokbot-cli-webhook); it is never printed.\n" +
        `Webhook URL: ${HOOK_URL}\n` +
        'Fire it with: grokbot routines-fire "Primary Test" "Deploy hook"\n',
      'Fired routine Deploy hook (auto-9) on Primary Test: HTTP 202. Reply: {"ok":true}\n',
    ]);
  });
});
