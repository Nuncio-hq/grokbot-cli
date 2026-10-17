import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  checkTrigger,
  triggerFromFlags,
} from "./workforce-routine-triggers.js";

const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;
const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return failure(error);
  }
  return "no error";
};

describe("triggerFromFlags", () => {
  it("builds each flag kind", async () => {
    expect(await triggerFromFlags({ cron: " 0 9 * * 1 " })).toEqual({
      type: "cron",
      schedule: "0 9 * * 1",
    });
    expect(await triggerFromFlags({ webhook: true })).toEqual({
      type: "webhook",
    });
    expect(
      await triggerFromFlags({
        email: "bot+ci",
        from: ["ci@example.com"],
        "require-auth-pass": true,
      }),
    ).toEqual({
      type: "email",
      inbox: "bot+ci",
      from: ["ci@example.com"],
      requireAuthPass: true,
    });
    expect(
      await triggerFromFlags({
        github: "owner/repo",
        events: ["ci-failed", "pr-opened"],
        "ci-branch": "main",
        pr: 7,
      }),
    ).toEqual({
      type: "github",
      repo: "owner/repo",
      events: ["ci-failed", "pr-opened"],
      pr: 7,
      ciBranch: "main",
    });
  });

  it("names no trigger when no kind is given, even with webhook false", async () => {
    expect(await triggerFromFlags({ webhook: false })).toBeUndefined();
  });

  it("reads a trigger from JSON text or a file and checks it", async () => {
    const slack = { type: "slack", channel: "C1", match: { kind: "mention" } };
    expect(await triggerFromFlags({ trigger: JSON.stringify(slack) })).toEqual(
      slack,
    );
    const dir = mkdtempSync(join(tmpdir(), "grokbot-trigger-"));
    const file = join(dir, "trigger.json");
    writeFileSync(file, JSON.stringify(slack));
    expect(await triggerFromFlags({ "trigger-file": file })).toEqual(slack);
    expect(await triggerFromFlags({ trigger: "{" }).catch(failure)).toEqual([
      "not-found",
      "The trigger is not valid JSON.",
    ]);
  });

  it("refuses two kinds, and a kind's options without that kind", async () => {
    expect(
      await triggerFromFlags({ cron: "0 9 * * 1", webhook: true }).catch(
        failure,
      ),
    ).toEqual(["not-found", "Name one trigger, not --cron and --webhook."]);
    expect(
      await triggerFromFlags({ webhook: true, events: ["ci-failed"] }).catch(
        failure,
      ),
    ).toEqual(["not-found", "--events goes with --github."]);
    expect(
      await triggerFromFlags({ github: "owner/repo" }).catch(failure),
    ).toEqual(["not-found", "--github needs --events."]);
    expect(
      await triggerFromFlags({
        github: "owner/repo",
        events: ["ci-broke"],
      }).catch(failure),
    ).toEqual([
      "not-found",
      expect.stringContaining(
        "The github trigger's events is missing or wrong",
      ),
    ]);
  });
});

describe("checkTrigger", () => {
  it("accepts a group of two or more triggers", () => {
    const group = {
      type: "group",
      listeners: [{ type: "webhook" }, { type: "cron", schedule: "0 9 * * 1" }],
    };
    expect(checkTrigger(group)).toBe(group);
  });

  it("refuses a short group, a nested group, unknown types and unknown fields", () => {
    expect(
      thrown(() =>
        checkTrigger({ type: "group", listeners: [{ type: "webhook" }] }),
      ),
    ).toEqual(["not-found", "A group trigger needs at least two listeners."]);
    expect(
      thrown(() =>
        checkTrigger({
          type: "group",
          listeners: [{ type: "webhook" }, { type: "group", listeners: [] }],
        }),
      ),
    ).toEqual([
      "not-found",
      expect.stringContaining('Unknown trigger type "group"'),
    ]);
    expect(thrown(() => checkTrigger({ type: "fax" }))).toEqual([
      "not-found",
      expect.stringContaining('Unknown trigger type "fax"'),
    ]);
    expect(
      thrown(() => checkTrigger({ type: "webhook", secret: "x" })),
    ).toEqual(["not-found", "The webhook trigger has unknown fields: secret."]);
    expect(
      thrown(() =>
        checkTrigger({ type: "cron", schedule: "0 9 * * 1", timing: "soon" }),
      ),
    ).toEqual([
      "not-found",
      "The cron trigger's timing is missing or wrong (one of: exact, flexible).",
    ]);
  });
});
