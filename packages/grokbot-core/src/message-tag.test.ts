import { describe, expect, it } from "vitest";
import { withMessageTag } from "./message-tag.js";

const ADDRESS = "omp:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("withMessageTag", () => {
  it.each([
    [
      "project and runtime",
      "hello",
      "ProjectName",
      "omp",
      undefined,
      "[Project: ProjectName · Runtime: omp] hello",
    ],
    [
      "project, runtime and session",
      "hello",
      "ProjectName",
      "omp",
      ADDRESS,
      `[Project: ProjectName · Runtime: omp · Session: ${ADDRESS}] hello`,
    ],
    [
      "runtime and session, no project",
      "hello",
      undefined,
      "omp",
      ADDRESS,
      `[Runtime: omp · Session: ${ADDRESS}] hello`,
    ],
    [
      "runtime only",
      "hello",
      undefined,
      "codex",
      undefined,
      "[Runtime: Codex] hello",
    ],
    [
      "a display name",
      "hello",
      "Proj",
      "claude-code",
      "claude-code:b1b2c3d4",
      "[Project: Proj · Runtime: Claude Code · Session: claude-code:b1b2c3d4] hello",
    ],
    [
      "an unknown agent",
      "hello",
      "Proj",
      "other-agent",
      undefined,
      "[Project: Proj · Runtime: an AI agent] hello",
    ],
    [
      "a person: the project label alone, never a session",
      "hello",
      "Proj",
      "human",
      ADDRESS,
      "[Project: Proj] hello",
    ],
    [
      "a person without a label: nothing",
      "hello",
      undefined,
      "human",
      ADDRESS,
      "hello",
    ],
    [
      "a host with no caller",
      "hello",
      "Proj",
      undefined,
      ADDRESS,
      "[Project: Proj] hello",
    ],
    [
      "a script",
      "hello",
      undefined,
      "script",
      undefined,
      "[Runtime: script] hello",
    ],
  ] as const)("heads %s", (_, text, label, caller, address, expected) => {
    expect(withMessageTag(text, label, caller, address)).toBe(expected);
  });

  it("applies the header once, whatever the case", () => {
    const full = `[Project: Proj · Runtime: omp · Session: ${ADDRESS}] hello`;
    expect(withMessageTag(full, "Proj", "omp", ADDRESS)).toBe(full);
    const loud = `  [project: PROJ · runtime: OMP · session: ${ADDRESS.toUpperCase()}] hello`;
    expect(withMessageTag(loud, "Proj", "omp", ADDRESS.toUpperCase())).toBe(
      loud,
    );
    const once = withMessageTag("hello", "Proj", "codex", "codex:thread-1");
    expect(withMessageTag(once, "Proj", "codex", "codex:thread-1")).toBe(once);
  });

  it("upgrades the older headers of an earlier grokbot instead of adding a second one", () => {
    expect(withMessageTag("[Proj] hello", "Proj", "omp", ADDRESS)).toBe(
      `[Project: Proj · Runtime: omp · Session: ${ADDRESS}] hello`,
    );
    expect(withMessageTag("  [proj · OMP] hello", "Proj", "omp")).toBe(
      "[Project: Proj · Runtime: omp] hello",
    );
    expect(withMessageTag("[omp] hello", undefined, "omp", ADDRESS)).toBe(
      `[Runtime: omp · Session: ${ADDRESS}] hello`,
    );
    expect(withMessageTag("[Proj] hello", "Proj", "human")).toBe(
      "[Project: Proj] hello",
    );
  });

  it("adds a session the header lacked, and replaces one that is not this session's", () => {
    expect(
      withMessageTag(
        "[Project: Proj · Runtime: omp] hello",
        "Proj",
        "omp",
        ADDRESS,
      ),
    ).toBe(`[Project: Proj · Runtime: omp · Session: ${ADDRESS}] hello`);
    expect(
      withMessageTag(
        "[Project: Proj · Runtime: omp · Session: omp:someone-else] hello",
        "Proj",
        "omp",
        ADDRESS,
      ),
    ).toBe(`[Project: Proj · Runtime: omp · Session: ${ADDRESS}] hello`);
    expect(
      withMessageTag(
        "[Project: Proj · Runtime: omp · Session: omp:someone-else] hello",
        "Proj",
        "omp",
      ),
    ).toBe("[Project: Proj · Runtime: omp] hello");
  });

  it("puts the header before other brackets, and leaves an unlabeled person's text alone", () => {
    expect(withMessageTag("[Other] hello", "Proj", "omp")).toBe(
      "[Project: Proj · Runtime: omp] [Other] hello",
    );
    expect(withMessageTag("[Proj · omp] hello", "Proj", "codex")).toBe(
      "[Project: Proj · Runtime: Codex] [Proj · omp] hello",
    );
    expect(withMessageTag("[Other] hello", undefined, "human")).toBe(
      "[Other] hello",
    );
  });

  it("ends an agent's header with the job, with or without a session", () => {
    expect(withMessageTag("hi", "Proj", "omp", ADDRESS, "1f2e3d4c")).toBe(
      `[Project: Proj · Runtime: omp · Session: ${ADDRESS} · Job: 1f2e3d4c] hi`,
    );
    expect(
      withMessageTag("hi", undefined, "codex", undefined, "1f2e3d4c"),
    ).toBe("[Runtime: Codex · Job: 1f2e3d4c] hi");
  });

  it("names no job for a person, and replaces another job's header instead of adding a second", () => {
    expect(withMessageTag("hi", "Proj", "human", ADDRESS, "1f2e3d4c")).toBe(
      "[Project: Proj] hi",
    );
    expect(
      withMessageTag(
        `[Project: Proj · Runtime: omp · Session: ${ADDRESS} · Job: aaaaaaaa] hi`,
        "Proj",
        "omp",
        ADDRESS,
        "1f2e3d4c",
      ),
    ).toBe(
      `[Project: Proj · Runtime: omp · Session: ${ADDRESS} · Job: 1f2e3d4c] hi`,
    );
  });
});
