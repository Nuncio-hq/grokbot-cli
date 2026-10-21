import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("the bot-side inbox skill", () => {
  it("is named grokbot-inbox and ships in the npm package", async () => {
    const skill = await read("../skills/grokbot-inbox/SKILL.md");
    expect(skill).toMatch(/^---\nname: grokbot-inbox\ndescription: .+\n---\n/);
    const pkg = JSON.parse(await read("../package.json")) as {
      files: string[];
    };
    expect(pkg.files).toContain("skills/");
  });

  it("names the commands a bot runs and the kinds it posts", async () => {
    const skill = await read("../skills/grokbot-inbox/SKILL.md");
    for (const word of [
      "npm i -g grokbotagent-cli",
      "inbox-post",
      "inbox-update",
      "inbox-close",
      "dedupeKey",
      "bug",
      "task",
      "question",
      "result",
      "decision",
    ]) {
      expect(skill).toContain(word);
    }
  });
});
