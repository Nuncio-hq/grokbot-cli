import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * `grokbot setup-prompt`: prints the prompt an owner pastes into their agent runtime to
 * set grokbot up in conversation, following the shipped skill. Local like config: no
 * network, no Keychain, no runner, never offered over MCP.
 */
export const SETUP_PROMPT_SUMMARY =
  "Print a prompt to paste into your agent, so it sets grokbot up with you";

export const SETUP_PROMPT_HELP = [
  SETUP_PROMPT_SUMMARY,
  "",
  "Usage: grokbot setup-prompt",
  "",
  "Prints a short prompt on stdout. Paste it into any agent runtime (Claude Code, Codex,",
  "Cursor, omp, Hermes...). The agent reads the grokbot skill that ships with this",
  "install and does first-time setup with you in conversation. It sends no bot a message",
  "except one read-only question you approve, and changes nothing on your bots.",
  "",
].join("\n");

const USAGE = "Usage: grokbot setup-prompt";

/** Where the skill sits in the package: the same offset from `src/` and from `dist/`. */
const SKILL_FILE = new URL("../skills/grokbot/SKILL.md", import.meta.url);

/** Named when the skill is not found next to the running module. Never resolved here: npm is not run. */
const NPM_ROOT_SKILL = "<npm root -g>/grokbotagent-cli/skills/grokbot/SKILL.md";

/** Where the skill lives and how to check it, injectable so tests never depend on the install. */
export interface SetupPromptDeps {
  /** Absolute path of the skill beside this module. */
  readonly skillPath: string;
  exists(path: string): Promise<boolean>;
}

export function defaultSetupPromptDeps(): SetupPromptDeps {
  return {
    skillPath: fileURLToPath(SKILL_FILE),
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
  };
}

/** The prompt for an agent runtime, naming the skill by `skill` (a path, or the npm-root form). */
export function setupPrompt(skill: string, found: boolean): string {
  return [
    "You are setting up grokbot with me for the first time. grokbot is a command line tool for working with my GrokBot bots.",
    "",
    found
      ? `1. Read the skill at ${skill}`
      : `1. Read the skill at ${skill} (replace <npm root -g> with the output of \`npm root -g\`).`,
    "2. If your agent runtime supports skills, install it the way your runtime does, so future sessions load it. Otherwise keep using it from that path.",
    '3. Do the skill\'s "First-time setup" section with me, step by step.',
    "",
    "During setup, send no bot any message except the one question that section allows, and hire, push, delete or change nothing on my bots.",
    "",
  ].join("\n");
}

interface SetupPromptContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  /** Whether stderr is a terminal; the hint prints only then, so a pipe or an agent's capture gets the prompt alone. */
  readonly isTTY: boolean;
  readonly deps: SetupPromptDeps;
}

/** Runs `grokbot setup-prompt` and returns its exit code. */
export async function runSetupPromptCommand(
  args: readonly string[],
  ctx: SetupPromptContext,
): Promise<number> {
  const unknown = args[0];
  if (unknown !== undefined) {
    ctx.stderr.write(`grokbot: setup-prompt: unknown argument "${unknown}"\n`);
    ctx.stderr.write(`${USAGE}\n`);
    return EXIT_CODE.usage;
  }
  const { skillPath } = ctx.deps;
  const found = await ctx.deps.exists(skillPath);
  ctx.stdout.write(setupPrompt(found ? skillPath : NPM_ROOT_SKILL, found));
  if (ctx.isTTY) ctx.stderr.write("Paste this into your agent.\n");
  return EXIT_CODE.ok;
}
