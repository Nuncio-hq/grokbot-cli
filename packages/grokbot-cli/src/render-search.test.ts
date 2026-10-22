import { describe, expect, it } from "vitest";
import { PRIMARY } from "./fixtures/cli-fixtures.js";
import { runCli } from "./fixtures/run-cli.js";

/** A moment in this computer's time zone, which is how `search` prints times. */
const local = (hour: number, minute: number) =>
  new Date(2026, 9, 22, hour, minute).getTime();

const bot = {
  entryId: "t150s425",
  seq: 425,
  role: "assistant",
  timestampMs: local(14, 5),
  snippet: "MAIN-PONG",
};
const owner = {
  entryId: "t150u",
  seq: 424,
  role: "user",
  timestampMs: local(9, 3),
  snippet: "…ply with the\n   single word MAIN-PONG.",
};

const found = (
  overrides: Partial<{
    query: string;
    matches: (typeof bot)[];
    nextBeforeSeq: number;
  }> = {},
) => ({
  search: {
    agent: PRIMARY,
    query: "PONG",
    matches: [bot, owner],
    isComplete: true,
    ...overrides,
  },
});

describe("search in human mode", () => {
  it("prints one line per match: seq, entry id, who, local time, the words", async () => {
    const run = await runCli(["search", "PONG"], { outputs: found() });
    expect(run).toMatchObject({
      stdout: [
        "[425 t150s425] bot 2026-10-22 14:05: MAIN-PONG",
        "[424 t150u] you 2026-10-22 09:03: …ply with the single word MAIN-PONG.",
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    });
  });

  it("says so when nothing matches", async () => {
    const run = await runCli(["search", "nothing"], {
      outputs: found({ matches: [] }),
    });
    expect(run).toMatchObject({ stdout: "No matches.\n", stderr: "", code: 0 });
  });

  it("names the command that reads the next page, on stderr", async () => {
    const run = await runCli(["search", "PONG", "-n", "2"], {
      outputs: found({ nextBeforeSeq: 424 }),
    });
    expect(run.stderr).toBe(
      "More: grokbot search PONG --before 424 --agent 'Primary Test'\n",
    );
  });

  it("quotes a query with spaces or quotes so the hint stays one command", async () => {
    const run = await runCli(["search", "it's PONG"], {
      outputs: found({ query: "it's PONG", nextBeforeSeq: 424 }),
    });
    expect(run.stderr).toBe(
      "More: grokbot search 'it'\\''s PONG' --before 424 --agent 'Primary Test'\n",
    );
  });

  it("hands the query, a default page of 20 and the flags to the runner", async () => {
    const plain = await runCli(["search", "PONG"], { outputs: found() });
    expect(plain.calls[0]).toMatchObject({
      name: "search",
      input: { query: "PONG", limit: 20, json: false },
    });
    expect(plain.calls[0]?.input).not.toHaveProperty("before");

    const paged = await runCli(
      ["search", "PONG", "-n", "5", "--before", "424", "--agent", "Staff Test"],
      { outputs: found() },
    );
    expect(paged.calls[0]?.input).toEqual({
      query: "PONG",
      limit: 5,
      before: 424,
      agent: "Staff Test",
      json: false,
    });
  });
});
