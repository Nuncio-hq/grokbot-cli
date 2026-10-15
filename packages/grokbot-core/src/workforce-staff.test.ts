import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  methods,
  PROBE,
  PROBE_BOT,
  PROBE_BRIEF,
  STAFF,
  wireBot,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

describe("hire", () => {
  it("creates a temporal bot with its brief, then writes the brief to the Cloud Box", async () => {
    const { runner, log } = workforceRunner(
      {
        ListGrokBotAgents: [{ agents: BASE_ROSTER }],
        CreateGrokBotTemporalAgent: created,
      },
      { updateAgent: [{}] },
    );
    const out = await runner.run("hire", HIRE);
    const id = out.agent.agentId;
    expect(id).toMatch(UUID);
    expect([out.result, out.folder, out.agent.description]).toEqual([
      "created",
      "/workspace/staff/gb-phase2-probe/",
      PROBE_BRIEF,
    ]);
    expect(log.map((c) => [c.via, c.method, c.body])).toEqual([
      ["server", "ListGrokBotAgents", {}],
      [
        "server",
        "CreateGrokBotTemporalAgent",
        {
          agentId: id,
          name: "GB Phase2 Probe",
          title: "Probe",
          description: PROBE_BRIEF,
          avatarShape: "blob",
          avatarColor: "black",
          harness: "GROK_BOT_AGENT_HARNESS_TEMPORAL",
          kickstartRequested: false,
          introductionSuppressed: true,
          language: "en",
        },
      ],
      [
        "gateway",
        "updateAgent",
        {
          id,
          profile: {
            name: "GB Phase2 Probe",
            title: "Probe",
            description: PROBE_BRIEF,
          },
        },
      ],
    ]);
  });

  it("puts an instructions file between the summary and the folder rule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbot-hire-"));
    const file = join(dir, "brief.txt");
    await writeFile(file, "Answer in English.\n");
    const { runner } = workforceRunner(
      {
        ListGrokBotAgents: [{ agents: BASE_ROSTER }],
        CreateGrokBotTemporalAgent: created,
      },
      { updateAgent: [{}] },
    );
    const out = await runner.run("hire", {
      ...HIRE,
      "instructions-file": file,
    });
    expect(out.agent.description).toBe(
      PROBE_BRIEF.replace(
        "Temporary bot",
        "Temporary bot\n\nInstructions:\nAnswer in English.",
      ),
    );
  });

  it("run again, adopts the bot it hired and briefs it again instead of making a twin", async () => {
    const { runner, log } = workforceRunner(
      { ListGrokBotAgents: [{ agents: [...BASE_ROSTER, PROBE_BOT] }] },
      { updateAgent: [{}] },
    );
    const out = await runner.run("hire", HIRE);
    expect([out.result, out.agent.agentId]).toEqual(["adopted", PROBE]);
    expect(methods(log)).toEqual([
      "server:ListGrokBotAgents",
      "gateway:updateAgent",
    ]);
    expect(bodyOf(log, "updateAgent")).toEqual({
      id: PROBE,
      profile: {
        name: "GB Phase2 Probe",
        title: "Probe",
        description: PROBE_BRIEF,
      },
    });
  });

  it("refuses a name a bot it did not hire already uses", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: [{ agents: BASE_ROSTER }],
    });
    const error = await runner
      .run("hire", { ...HIRE, name: "staff test" })
      .catch(failure);
    expect(error).toEqual([
      "ambiguous",
      `A bot named "Staff Test" already exists (${STAFF}). Pick another name, or change that bot with grokbot update.`,
    ]);
    expect(methods(log)).toEqual(["server:ListGrokBotAgents"]);
  });

  it("retries a timed-out create with the same agentId and keeps the bot that landed", async () => {
    let sent: JsonObject | undefined;
    const { runner, log } = workforceRunner(
      {
        ListGrokBotAgents: () => ({
          agents: sent ? [...BASE_ROSTER, created(sent).agent] : BASE_ROSTER,
        }),
        CreateGrokBotTemporalAgent: (body) => {
          sent = body;
          throw new GrokBotError(
            "http",
            "CreateGrokBotTemporalAgent failed with HTTP 504",
          );
        },
      },
      { updateAgent: [{}] },
    );
    const out = await runner.run("hire", HIRE);
    expect([out.result, out.agent.agentId]).toEqual(["created", sent?.agentId]);
    expect(methods(log)).toEqual([
      "server:ListGrokBotAgents",
      "server:CreateGrokBotTemporalAgent",
      "server:ListGrokBotAgents",
      "gateway:updateAgent",
    ]);
  });

  it("says how to finish when the bot exists but the Cloud Box refused the brief", async () => {
    const { runner } = workforceRunner(
      {
        ListGrokBotAgents: [{ agents: BASE_ROSTER }],
        CreateGrokBotTemporalAgent: created,
      },
      {
        updateAgent: () => {
          throw new GrokBotError("http", "EnsureSandBox failed with HTTP 503");
        },
      },
    );
    const error = await runner.run("hire", HIRE).catch(failure);
    expect(
      Array.isArray(error) && [
        error[0],
        String(error[1]).replace(UUID, "<id>"),
      ],
    ).toEqual([
      "http",
      "Created GB Phase2 Probe but could not brief it (EnsureSandBox failed with HTTP 503). Run the same hire again to finish.",
    ]);
  });
});
