import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  MAIN,
  methods,
  PRIMARY,
  PROBE,
  PROBE_BOT,
  PROBE_BRIEF,
  STAFF,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const ROSTER = { agents: [...BASE_ROSTER, PROBE_BOT] };
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;

describe("update", () => {
  const listed = (description: string) => [
    {
      agents: [
        { id: PROBE, name: "GB Phase2 Probe", title: "Probe", description },
      ],
    },
  ];
  const synced = (title: string) => ({
    agents: [...BASE_ROSTER, { ...PROBE_BOT, title, description: PROBE_BRIEF }],
  });

  it("merges the change into the Cloud Box profile and checks the server sees it", async () => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: [ROSTER, synced("Probe (updated)")] },
      { listAgents: listed(PROBE_BRIEF), updateAgent: [{}] },
    );
    const out = await runner.run("update", {
      agent: "GB Phase2 Probe",
      title: "Probe (updated)",
      json: false,
    });
    expect([out.changed, out.agent.title]).toEqual([
      ["title"],
      "Probe (updated)",
    ]);
    expect(methods(log)).toEqual([
      "server:ListGrokBotAgents",
      "gateway:listAgents",
      "gateway:updateAgent",
      "server:ListGrokBotAgents",
    ]);
    expect(bodyOf(log, "updateAgent")).toEqual({
      id: PROBE,
      profile: {
        name: "GB Phase2 Probe",
        title: "Probe (updated)",
        description: PROBE_BRIEF,
      },
    });
  });

  it("writes nothing when the bot already has the values", async () => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: [ROSTER] },
      { listAgents: listed(PROBE_BRIEF) },
    );
    const out = await runner.run("update", {
      agent: "GB Phase2 Probe",
      title: "Probe",
      json: false,
    });
    expect([out.changed, methods(log)]).toEqual([
      [],
      ["server:ListGrokBotAgents", "gateway:listAgents"],
    ]);
  });

  it("reads instructions from a file, and fails when the server does not show the change", async () => {
    const file = join(
      await mkdtemp(join(tmpdir(), "grokbot-update-")),
      "i.txt",
    );
    await writeFile(file, "Say hi.\n");
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: [ROSTER, ROSTER] },
      { listAgents: listed("Temporary bot"), updateAgent: [{}] },
    );
    const error = await runner
      .run("update", {
        agent: "GB Phase2 Probe",
        "instructions-file": file,
        json: false,
      })
      .catch(failure);
    expect(bodyOf(log, "updateAgent")?.profile).toEqual({
      name: "GB Phase2 Probe",
      title: "Probe",
      description: "Temporary bot\n\nInstructions:\nSay hi.",
    });
    expect(error).toEqual([
      "protocol",
      "updateAgent accepted the change, but ListGrokBotAgents does not show it yet for GB Phase2 Probe.",
    ]);
  });

  it("needs at least one field, and says so before any call", async () => {
    const { runner, log } = workforceRunner({});
    const error = await runner
      .run("update", { agent: "GB Phase2 Probe", json: false })
      .catch(failure);
    expect([error, log]).toEqual([
      [
        "not-found",
        "Nothing to update. Pass --title, --description, --instructions, or --instructions-file.",
      ],
      [],
    ]);
  });

  it("sends only the profile fields the gateway row has, plus the ones it changes", async () => {
    const { runner, log } = workforceRunner(
      {
        ListGrokBotAgents: [
          ROSTER,
          {
            agents: [
              ...BASE_ROSTER,
              {
                ...PROBE_BOT,
                description: "Temporary bot\n\nInstructions:\nSay hi.",
              },
            ],
          },
        ],
      },
      {
        listAgents: [
          [
            {
              id: PROBE,
              name: "GB Phase2 Probe",
              description: "Temporary bot",
            },
          ],
        ],
        updateAgent: [{}],
      },
    );
    await runner.run("update", {
      agent: "GB Phase2 Probe",
      instructions: "Say hi.",
      json: false,
    });
    expect(bodyOf(log, "updateAgent")).toEqual({
      id: PROBE,
      profile: {
        name: "GB Phase2 Probe",
        description: "Temporary bot\n\nInstructions:\nSay hi.",
      },
    });
  });
});

describe("fire", () => {
  const FIRE = { yes: true, json: false };

  it("deletes the bot by agentId, confirmed", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: [{ agents: [...BASE_ROSTER, PROBE_BOT] }],
      DeleteGrokBotAgent: [{}],
    });
    const out = await runner.run("fire", { ...FIRE, agent: "GB Phase2 Probe" });
    expect(out.agent.agentId).toBe(PROBE);
    expect(log.at(-1)).toEqual({
      via: "server",
      method: "DeleteGrokBotAgent",
      body: { id: PROBE },
      confirmed: true,
    });
  });

  it.each([
    ["Grok Bot", MAIN],
    ["Primary Test", PRIMARY],
    ["Staff Test", STAFF],
  ])(
    "refuses %s without --force-protected, before deleting",
    async (name, id) => {
      const { runner, log } = workforceRunner({
        ListGrokBotAgents: [{ agents: BASE_ROSTER }],
      });
      const error = await runner
        .run("fire", { ...FIRE, agent: name })
        .catch(failure);
      expect(error).toEqual([
        "safety",
        `${name} (${id.slice(0, 8)}) is protected, so fire refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
      ]);
      expect(methods(log)).toEqual(["server:ListGrokBotAgents"]);
    },
  );

  it("stops before any call without --yes", async () => {
    const { runner, log } = workforceRunner({});
    const error = await runner
      .run("fire", { ...FIRE, agent: "GB Phase2 Probe", yes: false })
      .catch(failure);
    expect([error, log]).toEqual([
      ["safety", "fire changes or deletes live data. Re-run with --yes."],
      [],
    ]);
  });
});
