import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  PROBE,
  PROBE_BOT,
  PROBE_BRIEF,
  wireBot,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const HIRE = {
  name: "GB Phase2 Probe",
  title: "Probe",
  description: "Temporary bot",
  json: false,
};
const created = (body: JsonObject) => ({
  agent: wireBot(String(body.agentId), String(body.name), {
    title: body.title,
    description: body.description,
  }),
});
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;
const withInstructions = (text: string) =>
  PROBE_BRIEF.replace(
    "Temporary bot",
    `Temporary bot\n\nInstructions:\n${text}`,
  );

describe("hire run again on a bot it hired", () => {
  it("keeps the bot's instructions when no new ones are given", async () => {
    const briefed = { ...PROBE_BOT, description: withInstructions("Say hi.") };
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: [{ agents: [...BASE_ROSTER, briefed] }] },
      { updateAgent: [{}] },
    );
    const out = await runner.run("hire", HIRE);
    expect([out.result, bodyOf(log, "updateAgent")]).toEqual([
      "adopted",
      {
        id: PROBE,
        profile: {
          name: "GB Phase2 Probe",
          title: "Probe",
          description: withInstructions("Say hi."),
        },
      },
    ]);
  });

  it("replaces the instructions with text given as content", async () => {
    const briefed = { ...PROBE_BOT, description: withInstructions("Say hi.") };
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: [{ agents: [...BASE_ROSTER, briefed] }] },
      { updateAgent: [{}] },
    );
    await runner.run("hire", { ...HIRE, instructions: "Say bye.\n" });
    expect(bodyOf(log, "updateAgent")).toEqual({
      id: PROBE,
      profile: {
        name: "GB Phase2 Probe",
        title: "Probe",
        description: withInstructions("Say bye."),
      },
    });
  });

  it("refuses instructions given both as text and as a file, before any call", async () => {
    const { runner, log } = workforceRunner({});
    const error = await runner
      .run("hire", {
        ...HIRE,
        instructions: "x",
        "instructions-file": "/tmp/x.txt",
      })
      .catch(failure);
    expect([error, log]).toEqual([
      ["not-found", "Pass --instructions or --instructions-file, not both."],
      [],
    ]);
  });
});

describe("hire picks a folder no other bot uses", () => {
  it("adds the agentId prefix when another bot's name has the same slug", async () => {
    const qa = wireBot("0a0a0a0a-0000-4000-8000-000000000001", "QA Bot", {
      description:
        "Tests things\n\nWorkspace: your own folder is /workspace/staff/qa-bot/. Keep your files there; put files other bots need in /workspace/shared/.",
    });
    const { runner, log } = workforceRunner(
      {
        ListGrokBotAgents: [{ agents: [...BASE_ROSTER, qa] }],
        CreateGrokBotTemporalAgent: created,
      },
      { updateAgent: [{}] },
    );
    const out = await runner.run("hire", { ...HIRE, name: "QA-Bot" });
    const prefix = out.agent.agentId.slice(0, 8);
    expect([
      out.folder,
      String(bodyOf(log, "CreateGrokBotTemporalAgent")?.description).includes(
        `/workspace/staff/qa-bot-${prefix}/`,
      ),
    ]).toEqual([`/workspace/staff/qa-bot-${prefix}/`, true]);
  });
});
