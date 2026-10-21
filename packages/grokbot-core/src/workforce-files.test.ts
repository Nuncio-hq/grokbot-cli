import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  MAIN,
  methods,
  PROBE,
  PROBE_BOT,
  type Recorded,
  type Script,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";
import { MAX_TEAM_PAGES } from "./workforce-files.js";

const ROSTER = [{ agents: [...BASE_ROSTER, PROBE_BOT] }];
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;

const teamFile = (name: string, fields: JsonObject = {}) => ({
  name,
  path: `files/${name}`,
  sizeBytes: "2048",
  contentType: "text/markdown",
  updatedAtMs: "1760000000000",
  etag: `etag-${name}`,
  ...fields,
});
const mineFile = (path: string, fields: JsonObject = {}) => ({
  name: path.split("/").at(-1),
  path,
  sizeBytes: "10",
  updatedAtMs: "1760000100000",
  ...fields,
});

/** Runs one command on the probe bot; returns its result or error, and the call log. */
async function run(
  command: "files" | "files-remove",
  fields: JsonObject,
  server: Script,
  agent = "GB Phase2 Probe",
) {
  const { runner, log } = workforceRunner({
    ListGrokBotAgents: ROSTER,
    ...server,
  });
  const result = await runner
    .run(command as "files", { agent, json: false, ...fields } as never)
    .catch(failure);
  return { result, log, calls: methods(log).map((m) => m.slice(7)) };
}

const callsTo = (log: readonly Recorded[], method: string) =>
  log.filter((c) => c.method === method);

describe("files", () => {
  it("lists the team section, every page of it, then the private one, each file with its section", async () => {
    const { result, log } = await run(
      "files",
      {},
      {
        ListGrokBotAgentFiles: (body) =>
          body.pageToken === undefined
            ? {
                files: [teamFile("brief.md")],
                nextPageToken: "p2",
                totalBytes: "4096",
                canEdit: true,
              }
            : { files: [teamFile("plan.md")] },
        ListGrokBotUserStoreFiles: [{ files: [mineFile("notes/todo.txt")] }],
      },
    );
    expect(result).toMatchObject({
      agent: { agentId: PROBE },
      team: { totalBytes: 4096, canEdit: true, complete: true },
      files: [
        {
          section: "team",
          name: "brief.md",
          path: "files/brief.md",
          sizeBytes: 2048,
          updatedAt: "2025-10-09T08:53:20.000Z",
          contentType: "text/markdown",
        },
        { section: "team", name: "plan.md" },
        {
          section: "only-you",
          name: "todo.txt",
          path: "notes/todo.txt",
          sizeBytes: 10,
        },
      ],
    });
    expect(callsTo(log, "ListGrokBotAgentFiles").map((c) => c.body)).toEqual([
      { agentId: PROBE },
      { agentId: PROBE, pageToken: "p2" },
    ]);
    expect(callsTo(log, "ListGrokBotUserStoreFiles")[0]?.body).toEqual({
      agentId: PROBE,
    });
    expect(log.every((c) => !c.confirmed)).toBe(true);
  });

  it("returns no files and a team section you cannot edit when both lists are empty", async () => {
    const { result } = await run(
      "files",
      {},
      {
        ListGrokBotAgentFiles: [{}],
        ListGrokBotUserStoreFiles: [{}],
      },
    );
    expect(result).toMatchObject({
      files: [],
      team: { totalBytes: 0, canEdit: false, complete: true },
    });
  });

  it("lists the private files when the team has none", async () => {
    const { result } = await run(
      "files",
      {},
      {
        ListGrokBotAgentFiles: [{ canEdit: false }],
        ListGrokBotUserStoreFiles: [{ files: [mineFile("a.txt")] }],
      },
    );
    expect(result).toMatchObject({
      files: [{ section: "only-you", path: "a.txt" }],
    });
  });

  it("stops after the page cap and says the team listing is cut short", async () => {
    let page = 0;
    const { result, calls } = await run(
      "files",
      {},
      {
        ListGrokBotAgentFiles: () => ({
          files: [teamFile(`f${page}.md`)],
          nextPageToken: `p${++page}`,
        }),
        ListGrokBotUserStoreFiles: [{}],
      },
    );
    expect(result).toMatchObject({ team: { complete: false } });
    expect(calls.filter((m) => m === "ListGrokBotAgentFiles")).toHaveLength(
      MAX_TEAM_PAGES,
    );
  });

  it("fails on a page token the server repeats instead of looping", async () => {
    const { result } = await run(
      "files",
      {},
      {
        ListGrokBotAgentFiles: [{ nextPageToken: "same" }],
        ListGrokBotUserStoreFiles: [{}],
      },
    );
    expect(result).toEqual([
      "protocol",
      "ListGrokBotAgentFiles: repeated a page token",
    ]);
  });

  it.each([
    ["a file with no name in the team section", { files: [{ path: "x" }] }],
    [
      "a size that is not a number",
      { files: [teamFile("a", { sizeBytes: "big" })] },
    ],
    ["a files field that is not a list", { files: "none" }],
  ])("fails with a protocol error on %s", async (_label, reply) => {
    const { result } = await run(
      "files",
      {},
      {
        ListGrokBotAgentFiles: [reply],
        ListGrokBotUserStoreFiles: [{}],
      },
    );
    expect(result).toMatchObject([
      "protocol",
      expect.stringContaining("ListGrokBotAgentFiles"),
    ]);
  });
});

describe("files-remove", () => {
  const LISTINGS: Script = {
    ListGrokBotAgentFiles: [
      { files: [teamFile("brief.md"), teamFile("shared.md")], canEdit: true },
    ],
    ListGrokBotUserStoreFiles: [
      { files: [mineFile("notes/todo.txt"), mineFile("notes/shared.md")] },
    ],
    DeleteGrokBotUserStoreFile: [{}],
    DeleteGrokBotAgentFile: [{}],
  };
  const remove = (fields: JsonObject, server: Script = LISTINGS) =>
    run("files-remove", { yes: true, ...fields }, server);
  const deletes = (log: readonly Recorded[]) =>
    log
      .filter((c) => c.method.startsWith("DeleteGrokBot"))
      .map((c) => [c.method, c.body, c.confirmed]);

  it("needs --yes and touches nothing without it", async () => {
    const { result, calls } = await run(
      "files-remove",
      { path: "notes/todo.txt" },
      LISTINGS,
    );
    expect([result, calls]).toEqual([
      [
        "safety",
        "files-remove changes or deletes live data. Re-run with --yes.",
      ],
      [],
    ]);
  });

  it("removes a private file by its path with DeleteGrokBotUserStoreFile", async () => {
    const { result, log } = await remove({ path: "notes/todo.txt" });
    expect(result).toMatchObject({
      file: { section: "only-you", path: "notes/todo.txt" },
    });
    expect(deletes(log)).toEqual([
      [
        "DeleteGrokBotUserStoreFile",
        { agentId: PROBE, path: "notes/todo.txt" },
        true,
      ],
    ]);
  });

  it("removes a team file by its name with DeleteGrokBotAgentFile when the team files are editable", async () => {
    const { result, log } = await remove({ path: "brief.md" });
    expect(result).toMatchObject({
      file: { section: "team", name: "brief.md" },
    });
    expect(deletes(log)).toEqual([
      ["DeleteGrokBotAgentFile", { agentId: PROBE, name: "brief.md" }, true],
    ]);
  });

  it("refuses a team file the caller may not edit, and deletes nothing", async () => {
    const { result, log } = await remove(
      { path: "brief.md" },
      {
        ...LISTINGS,
        ListGrokBotAgentFiles: [{ files: [teamFile("brief.md")] }],
      },
    );
    expect(result).toEqual([
      "safety",
      "You cannot edit the team files of GB Phase2 Probe, so brief.md stays. Only the team files' editors can remove them.",
    ]);
    expect(deletes(log)).toEqual([]);
  });

  it("asks which one when a name fits files of both sections, then obeys --section", async () => {
    const both = await remove({ path: "shared.md" });
    expect(both.result).toMatchObject([
      "ambiguous",
      expect.stringContaining(
        "team: files/shared.md; only-you: notes/shared.md",
      ),
    ]);
    expect(deletes(both.log)).toEqual([]);

    const mine = await remove({ path: "shared.md", section: "only-you" });
    expect(deletes(mine.log)).toEqual([
      [
        "DeleteGrokBotUserStoreFile",
        { agentId: PROBE, path: "notes/shared.md" },
        true,
      ],
    ]);
  });

  it("prefers an exact path over a name that other files share", async () => {
    const { log } = await remove({ path: "notes/shared.md" });
    expect(deletes(log)).toEqual([
      [
        "DeleteGrokBotUserStoreFile",
        { agentId: PROBE, path: "notes/shared.md" },
        true,
      ],
    ]);
  });

  it("reports a missing file, and a section filter skips the other listing", async () => {
    const { result, calls } = await remove({
      path: "nope.txt",
      section: "only-you",
    });
    expect(result).toEqual([
      "not-found",
      'No file "nope.txt" in the only-you section. List them with grokbot files.',
    ]);
    expect(calls).toEqual(["ListGrokBotAgents", "ListGrokBotUserStoreFiles"]);
  });

  it("rejects an unknown --section before any listing", async () => {
    const { result, calls } = await remove({ path: "a", section: "mine" });
    expect(result).toEqual([
      "safety",
      '--section must be one of team, only-you, not "mine".',
    ]);
    expect(calls).toEqual([]);
  });

  it("warns that the team listing was cut short when a file is not found", async () => {
    let page = 0;
    const { result } = await remove(
      { path: "deep.md" },
      {
        ...LISTINGS,
        ListGrokBotAgentFiles: () => ({
          files: [teamFile(`f${page}.md`)],
          nextPageToken: `p${++page}`,
        }),
      },
    );
    expect(result).toMatchObject([
      "not-found",
      expect.stringContaining(`stopped after ${MAX_TEAM_PAGES} pages`),
    ]);
  });

  describe("on a protected bot", () => {
    const onMain = (fields: JsonObject) =>
      run(
        "files-remove",
        { yes: true, path: "notes/todo.txt", ...fields },
        LISTINGS,
        "Grok Bot",
      );

    it.each([
      ["no value", undefined],
      ["an 8-char prefix", MAIN.slice(0, 8)],
    ])("refuses given %s, before listing or deleting", async (_l, force) => {
      const { result, calls } = await onMain(
        force === undefined ? {} : { "force-protected": force },
      );
      expect(result).toEqual([
        "safety",
        `Grok Bot (${MAIN.slice(0, 8)}) is protected, so files-remove refuses it. To act on it anyway, use the grokbot CLI with --force-protected <its full agentId>.`,
      ]);
      expect(calls).toEqual(["ListGrokBotAgents"]);
    });

    it("goes ahead when --force-protected is its full agentId", async () => {
      const { result, log } = await onMain({ "force-protected": MAIN });
      expect(result).toMatchObject({ file: { path: "notes/todo.txt" } });
      expect(deletes(log)).toEqual([
        [
          "DeleteGrokBotUserStoreFile",
          { agentId: MAIN, path: "notes/todo.txt" },
          true,
        ],
      ]);
    });
  });

  it("lists files on a protected bot without --force-protected, since reading is safe", async () => {
    const { result } = await run(
      "files",
      {},
      { ListGrokBotAgentFiles: [{}], ListGrokBotUserStoreFiles: [{}] },
      "Grok Bot",
    );
    expect(result).toMatchObject({ files: [] });
  });
});
