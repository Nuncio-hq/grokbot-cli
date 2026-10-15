import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentId } from "./agents.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  httpError,
  methods,
  steps,
  wireBot,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";
import { pendingHires } from "./workforce-pending-hires.js";

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
const HIRE = {
  name: "GB Phase2 Probe",
  title: "Probe",
  description: "Temporary bot",
  json: false,
};
const CREATE = "CreateGrokBotTemporalAgent";
const created = (body: JsonObject) => ({
  agent: wireBot(String(body.agentId), String(body.name), {
    title: body.title,
    description: body.description,
  }),
});
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;
const pendingFile = (stateDir: string) =>
  join(stateDir, "pending-hires", "gb-phase2-probe.json");
const sentIds = (log: readonly { method: string; body: JsonObject }[]) =>
  log.filter((c) => c.method === CREATE).map((c) => c.body.agentId);

describe("hire after a create whose reply is lost", () => {
  it("keeps the id on disk when the roster is down too, and reuses it on the rerun", async () => {
    const first = workforceRunner({
      ListGrokBotAgents: steps(
        { agents: BASE_ROSTER },
        httpError("ListGrokBotAgents", 503),
      ),
      [CREATE]: steps(httpError(CREATE, 504)),
    });
    const error = await first.runner.run("hire", HIRE).catch(failure);
    const [id] = sentIds(first.log);
    const saved = await readFile(pendingFile(first.stateDir), "utf8");
    const mode = (await stat(pendingFile(first.stateDir))).mode & 0o777;
    expect(error).toEqual([
      "http",
      `Could not confirm ${id}: ${CREATE} failed with HTTP 504, then ListGrokBotAgents failed with HTTP 503. Run the same hire again; it reuses that id.`,
    ]);
    expect([JSON.parse(saved), mode]).toEqual([
      { name: "GB Phase2 Probe", agentId: id },
      0o600,
    ]);

    const rerun = workforceRunner(
      { ListGrokBotAgents: [{ agents: BASE_ROSTER }], [CREATE]: created },
      { updateAgent: [{}] },
      first.stateDir,
    );
    const out = await rerun.runner.run("hire", HIRE);
    expect([out.agent.agentId, sentIds(rerun.log)]).toEqual([id, [id]]);
    await expect(stat(pendingFile(first.stateDir))).rejects.toThrow(/ENOENT/);
  });

  it("clears the saved id once a rerun finds the bot it made on the roster", async () => {
    let landed: JsonObject | undefined;
    const first = workforceRunner({
      ListGrokBotAgents: steps(
        { agents: BASE_ROSTER },
        httpError("ListGrokBotAgents", 503),
      ),
      [CREATE]: (body) => {
        landed = created(body).agent;
        throw httpError(CREATE, 504);
      },
    });
    await first.runner.run("hire", HIRE).catch(() => undefined);
    const rerun = workforceRunner(
      { ListGrokBotAgents: () => ({ agents: [...BASE_ROSTER, landed] }) },
      { updateAgent: [{}] },
      first.stateDir,
    );
    const out = await rerun.runner.run("hire", HIRE);
    expect([out.result, out.agent.agentId, methods(rerun.log)]).toEqual([
      "adopted",
      landed?.agentId,
      ["server:ListGrokBotAgents", "gateway:updateAgent"],
    ]);
    await expect(stat(pendingFile(first.stateDir))).rejects.toThrow(/ENOENT/);
  });
});

describe("pendingHires", () => {
  it("returns a saved id for the same name only, and nothing for a damaged file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbot-pending-"));
    const store = pendingHires(dir);
    const id = "5ca1ab1e-0000-4000-8000-0000000000cc" as AgentId;
    await store.save("QA Bot", id);
    const sameSlugOtherName = await store.load("QA-Bot");
    const sameName = await store.load(" qa bot ");
    await writeFile(join(dir, "qa-bot.json"), "{not json");
    const damaged = await store.load("QA Bot");
    expect([sameSlugOtherName, sameName, damaged]).toEqual([
      undefined,
      id,
      undefined,
    ]);
  });
});

describe("hire retries only failures that may pass on a retry", () => {
  const network = new GrokBotError(
    "http",
    `${CREATE} request failed on the network.`,
  );
  const timeout = new GrokBotError(
    "timeout",
    `${CREATE} timed out after 60000 ms.`,
  );
  it.each([
    ["HTTP 400", httpError(CREATE, 400, "bad name"), 1],
    ["HTTP 409", httpError(CREATE, 409), 1],
    ["HTTP 503", httpError(CREATE, 503), 3],
    ["a network failure", network, 3],
    ["a timeout", timeout, 3],
  ])(
    "on %s retries as often as it should, with one id, and names that id",
    async (_label, error, tries) => {
      const { runner, log } = workforceRunner({
        ListGrokBotAgents: [{ agents: BASE_ROSTER }],
        [CREATE]: steps(error),
      });
      const thrown = await runner.run("hire", HIRE).catch(failure);
      const ids = sentIds(log);
      const named = Array.isArray(thrown) && String(thrown[1]).match(UUID)?.[0];
      expect([ids.length, new Set(ids).size, named === ids[0]]).toEqual([
        tries,
        1,
        true,
      ]);
    },
  );
});
