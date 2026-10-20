import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandRunner } from "./command-runner.js";
import type { CommandRunnerOptions } from "./command-runner-contract.js";
import { fakeServer } from "./fixtures/fake-server.js";
import { jobStore } from "./job-store.js";
import type { ProjectRoutes } from "./project-routes-store.js";

const PRIMARY = "f882ec52-17b1-4639-b0fc-07fed7526b09";
const STAFF = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";
const KIND = "GROK_BOT_AGENT_KIND_AGENT";
const ROSTER = {
  agents: [
    { id: "1", agentId: PRIMARY, name: "Primary Test", kind: KIND },
    { id: "2", agentId: STAFF, name: "Staff Test", kind: KIND },
  ],
};
const REMOTE = "github.com/example-org/example-app";

let root: string;
let setups = 0;
let app: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "grokbot-route-run-")));
  app = join(root, "app");
  await mkdir(app);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Calls = NonNullable<Parameters<typeof fakeServer>[0]["calls"]>;

function setup(
  options: CommandRunnerOptions,
  extra: Calls = {},
  settings: unknown = { settings: { mainAgentId: PRIMARY } },
) {
  const { server, log } = fakeServer({
    calls: {
      ListGrokBotAgents: [ROSTER],
      GetGrokBotUserRuntimeSettings: [settings],
      ListGrokBotTranscriptEntries: [{ entries: [] }],
      ListGrokBotAgentStatuses: [{ statuses: [] }],
      SendGrokBotUserMessage: [{ dispatched: true }],
      ...extra,
    },
  });
  const jobs = jobStore(join(root, `jobs-${++setups}`));
  const runner = createCommandRunner({ server, jobs, cwd: app, ...options });
  const tail = async (agent?: string) =>
    (
      await runner.run("tail", {
        limit: 1,
        json: false,
        ...(agent && { agent }),
      })
    ).agent.agentId;
  const read = (method: string) => log.filter((c) => c.method === method);
  return { runner, tail, read };
}

const routes =
  (map: ProjectRoutes): (() => Promise<ProjectRoutes>) =>
  async () =>
    map;
const pathRoute = (): ProjectRoutes => new Map([[app, { agentId: STAFF }]]);
const noRoutes = routes(new Map());

describe("agent resolution order", () => {
  it("--agent beats GROKBOT_AGENT, the project route and the primary Bot", async () => {
    const t = setup({
      defaultAgent: "Staff Test",
      projectRoutes: async () => new Map([[app, { agentId: STAFF }]]),
    });
    expect(await t.tail("Primary Test")).toBe(PRIMARY);
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(0);
  });

  it("GROKBOT_AGENT beats the project route and the primary Bot", async () => {
    const t = setup({
      defaultAgent: "Primary Test",
      projectRoutes: async () => new Map([[app, { agentId: STAFF }]]),
    });
    expect(await t.tail()).toBe(PRIMARY);
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(0);
  });

  it("the project route beats the primary Bot, which is then never read", async () => {
    const t = setup({ projectRoutes: async () => pathRoute() });
    expect(await t.tail()).toBe(STAFF);
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(0);
  });

  it("the git remote route beats a path route for the same folder", async () => {
    execFileSync("git", ["init", "-q"], { cwd: app });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Example-Org/Example-App.git"],
      { cwd: app },
    );
    const t = setup({
      projectRoutes: routes(
        new Map([
          [app, { agentId: PRIMARY }],
          [REMOTE, { agentId: STAFF }],
        ]),
      ),
    });
    expect(await t.tail()).toBe(STAFF);
  });

  it("the primary Bot answers when nothing earlier decides", async () => {
    const t = setup({ projectRoutes: noRoutes });
    expect(await t.tail()).toBe(PRIMARY);
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(1);
  });

  it("a route to a bot that is not on the account is an error, not the primary", async () => {
    const t = setup({
      projectRoutes: routes(
        new Map([[app, { agentId: "0a1b2c3d-1111-4111-8111-111111111111" }]]),
      ),
    });
    await expect(t.tail()).rejects.toThrow("not on this account");
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(0);
  });

  it.each([
    ["settings without a main agent", { settings: {} }],
    ["an empty settings reply", {}],
    ["a blank main agent", { settings: { mainAgentId: "" } }],
  ])("%s: no agent selected and no primary Bot", async (_label, settings) => {
    const t = setup({ projectRoutes: noRoutes }, {}, settings);
    const error = await t.tail().catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "not-found",
      message: expect.stringMatching(
        /No agent selected.*no primary Bot.*--agent.*GROKBOT_AGENT.*grokbot config route/,
      ),
    });
  });

  it("an unreadable routes file stops the command instead of falling back to the primary", async () => {
    const t = setup({
      projectRoutes: async () => {
        throw new Error("routes file is broken");
      },
    });
    await expect(t.tail()).rejects.toThrow("routes file is broken");
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(0);
  });

  it("an explicit agent never reads the routes file", async () => {
    const t = setup({
      projectRoutes: async () => {
        throw new Error("routes file is broken");
      },
    });
    expect(await t.tail("Staff Test")).toBe(STAFF);
  });
});

describe("project label", () => {
  const sentText = (t: ReturnType<typeof setup>) =>
    t.read("SendGrokBotUserMessage").map((c) => c.body.text);
  const labeled = (): ProjectRoutes =>
    new Map([[app, { agentId: STAFF, label: "ProjectName" }]]);

  it("send prefixes the text once, whichever way the bot was chosen", async () => {
    const t = setup({ projectRoutes: routes(labeled()) });
    await t.runner.run("send", { text: "hello", json: false });
    await t.runner.run("send", {
      text: "[projectname] again",
      agent: "Primary Test",
      json: false,
    });
    expect(sentText(t)).toEqual(["[ProjectName] hello", "[projectname] again"]);
    // A different bot than the route's still carries the project label.
    const flagged = setup({ projectRoutes: routes(labeled()) });
    await flagged.runner.run("send", {
      text: "via flag",
      agent: "Primary Test",
      json: false,
    });
    expect(sentText(flagged)).toEqual(["[ProjectName] via flag"]);
  });

  it("sends the text untouched when the route has no label or there is no route", async () => {
    const plain = setup({ projectRoutes: async () => pathRoute() });
    await plain.runner.run("send", { text: "hello", json: false });
    const none = setup({ projectRoutes: noRoutes });
    await none.runner.run("send", {
      text: "hello",
      agent: "Primary Test",
      json: false,
    });
    expect([sentText(plain), sentText(none)]).toEqual([["hello"], ["hello"]]);
  });

  it("ask prefixes the text too", async () => {
    const t = setup({ projectRoutes: routes(labeled()) });
    await t.runner
      .run("ask", { text: "hello", timeout: 1, json: false })
      .catch(() => undefined);
    expect(sentText(t)).toEqual(["[ProjectName] hello"]);
  });
});
