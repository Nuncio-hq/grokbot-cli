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

const rowsOf = (table: string) => table.split("\n").slice(2, -1);
const usageCell = (row: string) => row.split("` |")[0]?.replace(/^\| `/, "");
const rowFor = (table: string, name: string) =>
  rowsOf(table).find((row) => usageCell(row)?.startsWith(`grokbot ${name}`)) ??
  "";

describe("renderCommandTable", () => {
  const catalog = listCommands();
  const table = renderCommandTable(catalog, [], false);

  it("renders one row per command with no flag named --json", () => {
    expect(rowsOf(table)).toHaveLength(catalog.length);
    for (const command of catalog) {
      expect(rowFor(table, command.name), command.name).toBeDefined();
    }
    expect(table).not.toContain("--json");
  });

  it("says a command needs --yes exactly when its safety asks for confirmation, and shows the flag", () => {
    for (const command of catalog) {
      const confirmed =
        command.safety === "destructive" || command.safety === "sensitive";
      const row = rowFor(table, command.name);
      expect(row.includes("needs --yes"), command.name).toBe(confirmed);
      if (confirmed) {
        expect(usageCell(row), command.name).toContain("--yes");
      }
    }
  });

  it("leaves required flags unbracketed, brackets optional ones and keeps short aliases", () => {
    const hire = usageCell(rowFor(table, "hire"));
    expect(hire).toContain(" --title <string>");
    expect(hire).toContain(" [--instructions <string>]");
    expect(usageCell(rowFor(table, "tail"))).toContain(" [-n <integer>]");
    expect(usageCell(rowFor(table, "room-create"))).toContain(
      " --member <string>...",
    );
  });

  it("renders the login flags from its help text", () => {
    const [login = ""] = rowsOf(renderCommandTable([], ["login"], false));
    expect(usageCell(login)).toBe("grokbot login [--no-browser] [--api-key]");
    expect(login).toContain("account, local only");
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
      TABLE_START,
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
