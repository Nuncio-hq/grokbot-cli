import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * `grokbot setup-prompt [assistant|bot]`: prints a prompt the owner pastes in, so setup
 * happens in conversation. `assistant` (the default) goes into their agent runtime and
 * follows the shipped `grokbot` skill; `bot` goes into their primary Bot's chat in the
 * GrokBot app and sets up the bots' side (grokbot on the cloud computer, the
 * `grokbot-inbox` skill, project names, one test item). Local like config: no network, no
 * Keychain, no runner, never offered over MCP.
 */
export const SETUP_PROMPT_SUMMARY =
  "Print a prompt to paste into your agent (or, with bot, into your primary Bot)";

export const SETUP_PROMPT_HELP = [
  SETUP_PROMPT_SUMMARY,
  "",
  "Usage: grokbot setup-prompt [assistant|bot]",
  "",
  "assistant (default): paste it into any agent runtime (Claude Code, Codex, Cursor, omp,",
  "  Hermes...). The agent reads the grokbot skill that ships with this install and does",
  "  first-time setup with you in conversation.",
  "bot: paste it into your primary Bot's chat in the GrokBot app. The bot installs grokbot",
  "  on its cloud computer, saves the grokbot-inbox skill for all your bots, checks your",
  "  project names with you, and posts one test item your agent then closes.",
  "Both prompts tell the bot or agent to change nothing else.",
  "",
].join("\n");

const USAGE = "Usage: grokbot setup-prompt [assistant|bot]";

/** The test item the bot posts and the assistant closes, proving both directions work. */
const SETUP_CHECK_PROJECT = "Setup check";

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
function setupPrompt(skill: string, found: boolean): string {
  return [
    "You are setting up grokbot with me for the first time. grokbot is a command line tool for working with my GrokBot bots.",
    "",
    found
      ? `1. Read the skill at ${skill}`
      : `1. Read the skill at ${skill} (replace <npm root -g> with the output of \`npm root -g\`).`,
    "2. If your agent runtime supports skills, install it the way your runtime does, so future sessions load it. Otherwise keep using it from that path.",
    '3. Do the skill\'s "First-time setup" section with me, step by step.',
    "",
    "During setup, send no bot any message except the ones that section allows, and hire, push, delete or change nothing on my bots.",
    "",
  ].join("\n");
}

/**
 * The prompt for the owner's primary Bot. It runs on the bot's cloud computer, so it names
 * the bot-side skill through that computer's own `npm root -g`, never a path from here.
 */
function botSetupPrompt(): string {
  return [
    "I'm setting up grokbot so my AI assistant and my bots can leave each other work. Please do this on your cloud computer, step by step, and tell me what happened at each step:",
    "",
    "1. Install or update grokbot: run `grokbot inbox-schema >/dev/null 2>&1 || npm i -g grokbotagent-cli@latest`, then `grokbot --version`.",
    '2. Read "$(npm root -g)/grokbotagent-cli/skills/grokbot-inbox/SKILL.md" and save it as a skill named grokbot-inbox, replacing an older one, so all my bots can use it.',
    "3. Tell me the projects you know about and which bot looks after each. I will correct the list; remember it, and use exactly those names as the project when you post an inbox item.",
    `4. Following that skill, post one test item: kind result, project "${SETUP_CHECK_PROJECT}", title "grokbot inbox works", expiring in 1 hour. Tell me its id; my assistant will mark it done.`,
    "",
    "Change nothing else: no routines, no new bots, and no messages to anyone.",
    "",
  ].join("\n");
}

type PromptFor = "assistant" | "bot";
const isPromptFor = (value: string): value is PromptFor =>
  value === "assistant" || value === "bot";

interface SetupPromptContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  /** Whether stderr is a terminal; the hint prints only then, so a pipe or an agent's capture gets the prompt alone. */
  readonly isTTY: boolean;
  readonly deps: SetupPromptDeps;
}

/** Runs `grokbot setup-prompt [assistant|bot]` and returns its exit code. */
export async function runSetupPromptCommand(
  args: readonly string[],
  ctx: SetupPromptContext,
): Promise<number> {
  const [which = "assistant", extra] = args;
  if (!isPromptFor(which) || extra !== undefined) {
    const bad = isPromptFor(which) ? extra : which;
    ctx.stderr.write(`grokbot: setup-prompt: unknown argument "${bad}"\n`);
    ctx.stderr.write(`${USAGE}\n`);
    return EXIT_CODE.usage;
  }
  if (which === "bot") {
    ctx.stdout.write(botSetupPrompt());
    if (ctx.isTTY)
      ctx.stderr.write(
        "Paste this into your primary Bot's chat in the GrokBot app.\n",
      );
    return EXIT_CODE.ok;
  }
  const { skillPath } = ctx.deps;
  const found = await ctx.deps.exists(skillPath);
  ctx.stdout.write(setupPrompt(found ? skillPath : NPM_ROOT_SKILL, found));
  if (ctx.isTTY)
    ctx.stderr.write(
      "Paste this into your agent. For your bots' side: grokbot setup-prompt bot\n",
    );
  return EXIT_CODE.ok;
}
