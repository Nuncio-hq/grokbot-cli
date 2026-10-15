import { readFile, writeFile } from "node:fs/promises";
import {
  renderCommandTable,
  spliceCommandTable,
} from "../src/skill-commands.js";

const skillUrl = new URL("../skills/grokbot/SKILL.md", import.meta.url);

const skill = await readFile(skillUrl, "utf8");
const next = spliceCommandTable(skill, renderCommandTable());
if (next === skill) {
  process.stdout.write("skills/grokbot/SKILL.md command table is current.\n");
} else {
  await writeFile(skillUrl, next);
  process.stdout.write("Rewrote the skills/grokbot/SKILL.md command table.\n");
}
