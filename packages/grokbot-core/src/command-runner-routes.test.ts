import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noAgentError } from "./agents.js";
import { BOT_SETUP_PROMPT } from "./bot-setup-prompt.js";
import { createCommandRunner } from "./command-runner.js";
import type {
  CommandRunner,
  CommandRunnerOptions,
} from "./command-runner-contract.js";
import { fakeServer, type RecordedCall } from "./fixtures/fake-server.js";
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

/** An empty session file made just now, in `folder` (created as needed). */
async function writeSession(folder: string, name: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), "");
}

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
  const runner = createCommandRunner({
    server,
    jobs,
    cwd: app,
    env: {},
    home: root,
    ...options,
  });
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

describe("message tag", () => {
  /** The sent texts, with the random job handle of an agent's header shown as `<job>`. */
  const sentText = (t: { read(method: string): RecordedCall[] }) =>
    t
      .read("SendGrokBotUserMessage")
      .map((c) =>
        String(c.body.text).replace(/Job: [0-9a-f]{8}/, "Job: <job>"),
      );
  const labeled = (): ProjectRoutes =>
    new Map([[app, { agentId: STAFF, label: "ProjectName" }]]);

  it("send starts with the project and the runtime, whichever way the bot was chosen", async () => {
    const routed = setup({ projectRoutes: routes(labeled()), caller: "omp" });
    await routed.runner.run("send", { text: "hello", json: false });
    const flagged = setup({ projectRoutes: routes(labeled()), caller: "omp" });
    await flagged.runner.run("send", {
      text: "again",
      agent: "Primary Test",
      json: false,
    });
    expect([sentText(routed), sentText(flagged)]).toEqual([
      ["[Project: ProjectName · Runtime: omp · Job: <job>] hello"],
      ["[Project: ProjectName · Runtime: omp · Job: <job>] again"],
    ]);
  });

  it("applies the tag once and upgrades the plain [label] an earlier grokbot wrote", async () => {
    const tagged = setup({ projectRoutes: routes(labeled()), caller: "codex" });
    await tagged.runner.run("send", {
      text: "[project: projectname · runtime: codex] tagged",
      json: false,
    });
    const old = setup({ projectRoutes: routes(labeled()), caller: "codex" });
    await old.runner.run("send", { text: "[ProjectName] old", json: false });
    expect([sentText(tagged), sentText(old)]).toEqual([
      ["[Project: ProjectName · Runtime: Codex · Job: <job>] tagged"],
      ["[Project: ProjectName · Runtime: Codex · Job: <job>] old"],
    ]);
  });

  it("tags with the runtime alone when the folder has no label or no route", async () => {
    const plain = setup({
      projectRoutes: async () => pathRoute(),
      caller: "gemini",
    });
    await plain.runner.run("send", { text: "hello", json: false });
    const none = setup({ projectRoutes: noRoutes, caller: "cursor" });
    await none.runner.run("send", {
      text: "hello",
      agent: "Primary Test",
      json: false,
    });
    expect([sentText(plain), sentText(none)]).toEqual([
      ["[Runtime: Gemini CLI · Job: <job>] hello"],
      ["[Runtime: Cursor · Job: <job>] hello"],
    ]);
  });

  it("names no runtime for a person typing: the project label alone, or nothing", async () => {
    const labelled = setup({
      projectRoutes: routes(labeled()),
      caller: "human",
    });
    await labelled.runner.run("send", { text: "hello", json: false });
    const none = setup({ projectRoutes: noRoutes, caller: "human" });
    await none.runner.run("send", {
      text: "hello",
      agent: "Primary Test",
      json: false,
    });
    expect([sentText(labelled), sentText(none)]).toEqual([
      ["[Project: ProjectName] hello"],
      ["hello"],
    ]);
  });

  it("leaves the text alone for a host that gave no caller and a folder with no label", async () => {
    const t = setup({ projectRoutes: noRoutes });
    await t.runner.run("send", {
      text: "hello",
      agent: "Primary Test",
      json: false,
    });
    expect(sentText(t)).toEqual(["hello"]);
  });

  it("ask carries the tag too", async () => {
    const t = setup({ projectRoutes: routes(labeled()), caller: "omp" });
    await t.runner
      .run("ask", { text: "hello", timeout: 1, json: false })
      .catch(() => undefined);
    expect(sentText(t)).toEqual([
      "[Project: ProjectName · Runtime: omp · Job: <job>] hello",
    ]);
  });

  it("names the caller's session when its runtime shows exactly one recent session of this folder", async () => {
    const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    await writeSession(
      join(root, ".omp/agent/sessions/-app"),
      `2026-10-20T03-18-28-912Z_${id}.jsonl`,
    );
    const t = setup({ projectRoutes: routes(labeled()), caller: "omp" });
    await t.runner.run("send", { text: "hello", json: false });
    expect(sentText(t)).toEqual([
      `[Project: ProjectName · Runtime: omp · Session: omp:${id} · Job: <job>] hello`,
    ]);
  });

  it("names no session when two recent sessions share the folder", async () => {
    const folder = join(root, ".omp/agent/sessions/-app");
    await writeSession(folder, "2026-10-20T03-18-28-912Z_aaaa1111.jsonl");
    await writeSession(folder, "2026-10-20T03-19-28-912Z_bbbb2222.jsonl");
    const t = setup({ projectRoutes: routes(labeled()), caller: "omp" });
    await t.runner.run("send", { text: "hello", json: false });
    expect(sentText(t)).toEqual([
      "[Project: ProjectName · Runtime: omp · Job: <job>] hello",
    ]);
  });

  it("takes the session from GROKBOT_SESSION and puts it in an upgraded older header", async () => {
    const t = setup({
      projectRoutes: routes(labeled()),
      caller: "codex",
      env: { GROKBOT_SESSION: "thread-0042" },
    });
    await t.runner.run("send", {
      text: "[ProjectName · Codex] old",
      json: false,
    });
    expect(sentText(t)).toEqual([
      "[Project: ProjectName · Runtime: Codex · Session: codex:thread-0042 · Job: <job>] old",
    ]);
  });
});

describe("setup-bots", () => {
  const STOP = "stop waiting";

  /** Runs setup-bots until its message is sent, then stops the wait: only where and what it sent matters here. */
  async function sent(
    t: {
      readonly runner: CommandRunner;
      read(method: string): RecordedCall[];
    },
    agent?: string,
  ) {
    const stop = new AbortController();
    await t.runner
      .run(
        "setup-bots",
        { timeout: 1, json: false, ...(agent && { agent }) },
        {
          signal: stop.signal,
          onEvent: (event) => {
            if (event.type === "dispatched") stop.abort(new Error(STOP));
          },
        },
      )
      .catch((error: unknown) => {
        if ((error as Error).message !== STOP) throw error;
      });
    return t
      .read("SendGrokBotUserMessage")
      .map((c) => ({ agentId: c.body.agentId, text: String(c.body.text) }));
  }

  it.each([
    ["a project route", { projectRoutes: async () => pathRoute() }],
    ["GROKBOT_AGENT", { defaultAgent: "Staff Test", projectRoutes: noRoutes }],
    [
      "both",
      { defaultAgent: "Staff Test", projectRoutes: async () => pathRoute() },
    ],
  ])(
    "goes to the primary Bot even when %s names another bot",
    async (_label, options) => {
      const messages = await sent(setup(options));
      expect(messages.map((m) => m.agentId)).toEqual([PRIMARY]);
    },
  );

  it("goes to --agent instead, over GROKBOT_AGENT, the route and the primary Bot, which is then never read", async () => {
    const t = setup({
      defaultAgent: "Primary Test",
      projectRoutes: routes(new Map([[app, { agentId: PRIMARY }]])),
    });
    const messages = await sent(t, "Staff Test");
    expect(messages.map((m) => m.agentId)).toEqual([STAFF]);
    expect(t.read("GetGrokBotUserRuntimeSettings")).toHaveLength(0);
  });

  it("sends the shared bot prompt, after grokbot's header when the caller is an agent runtime", async () => {
    const plain = await sent(setup({ projectRoutes: noRoutes }));
    const tagged = await sent(
      setup({ projectRoutes: noRoutes, caller: "omp" }),
    );
    expect(plain.map((m) => m.text)).toEqual([BOT_SETUP_PROMPT]);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.text).toMatch(/^\[Runtime: omp · Job: [0-9a-f]{8}\] /);
    expect(tagged[0]?.text.endsWith(BOT_SETUP_PROMPT)).toBe(true);
  });

  it.each([
    ["settings without a main agent", { settings: {} }],
    ["an empty settings reply", {}],
  ])(
    "%s: the no-agent error, and neither GROKBOT_AGENT nor a route stands in for the primary Bot",
    async (_label, settings) => {
      const t = setup(
        { defaultAgent: "Staff Test", projectRoutes: async () => pathRoute() },
        {},
        settings,
      );
      await expect(
        t.runner.run("setup-bots", { timeout: 1, json: false }),
      ).rejects.toMatchObject({
        code: "not-found",
        message: noAgentError().message,
      });
      expect(t.read("SendGrokBotUserMessage")).toHaveLength(0);
    },
  );
});
