import { readFile } from "node:fs/promises";
import { listCommands } from "grokbot-core";
import { describe, expect, it } from "vitest";
import {
  renderCommandTable,
  spliceCommandTable,
  TABLE_END,
  TABLE_START,
} from "./skill-commands.js";

const skillUrl = new URL("../skills/grokbot/SKILL.md", import.meta.url);

const pick = (...names: string[]) =>
  listCommands().filter((command) => names.includes(command.name));

describe("renderCommandTable", () => {
  it("renders one row per command, dropping --json and labelling safety", () => {
    expect(
      renderCommandTable(pick("agents", "fire", "approve"), ["whoami"], false),
    ).toBe(`| Command | Safety | What it does |
| --- | --- | --- |
| \`grokbot agents\` | read-only | List GrokBot agents on the account |
| \`grokbot fire <agent> [--force-protected <string>] [--yes]\` | destructive, needs --yes | Delete a bot or room |
| \`grokbot approve [--agent <string>] [--card <string>] [--always] [--yes]\` | sensitive, needs --yes | Approve an auto-review or local-tool permission card |
| \`grokbot whoami\` | account, local only | Show which sign-in grokbot uses, never the token |
`);
  });

  it("leaves required flags unbracketed and keeps short aliases", () => {
    expect(
      renderCommandTable(pick("hire", "room-create", "tail"), [], false),
    ).toBe(
      `| Command | Safety | What it does |
| --- | --- | --- |
| \`grokbot tail [-n <integer>] [--agent <string>]\` | read-only | Read recent decoded transcript entries |
| \`grokbot hire <name> --title <string> --description <string> [--instructions <string>] [--instructions-file <string>]\` | writes | Create a bot with a role and its own /workspace/staff folder |
| \`grokbot room-create <name> --member <string>... [--description <string>]\` | writes | Create a room where several bots answer one message |
`,
    );
  });

  it("renders the login flags from its help text", () => {
    expect(renderCommandTable([], ["login"]).split("\n")[2]).toBe(
      "| `grokbot login [--no-browser] [--api-key]` | account, local only | Sign grokbot in through the browser (own Keychain sign-in) |",
    );
  });

  it("covers every catalog command, then login, logout, whoami and stats, by default", () => {
    const named = [
      ...renderCommandTable().matchAll(/^\| `grokbot ([a-z-]+)/gm),
    ].map((match) => match[1]);
    expect(named).toEqual([
      ...listCommands().map((command) => command.name),
      "login",
      "logout",
      "whoami",
      "stats",
    ]);
  });
});

describe("spliceCommandTable", () => {
  it("replaces only the text between the markers", () => {
    const before = `intro\n${TABLE_START}\nold row\n${TABLE_END}\noutro\n`;
    expect(spliceCommandTable(before, "new row\n")).toBe(
      `intro\n${TABLE_START}\nnew row\n${TABLE_END}\noutro\n`,
    );
  });

  it("refuses a file without the markers", () => {
    expect(() => spliceCommandTable("no table here\n", "row\n")).toThrow(
      `SKILL.md has no generated command table. Add ${TABLE_START} and ${TABLE_END} on their own lines.`,
    );
  });
});

describe("skills/grokbot/SKILL.md", () => {
  it("lists every catalog and account command exactly as the catalog renders it (run bun run gen:skill to fix)", async () => {
    const skill = await readFile(skillUrl, "utf8");
    expect(spliceCommandTable(skill, renderCommandTable())).toBe(skill);
  });

  it("starts with frontmatter naming the skill grokbot", async () => {
    const skill = await readFile(skillUrl, "utf8");
    expect(skill.split("\n").slice(0, 2)).toEqual(["---", "name: grokbot"]);
  });
});
