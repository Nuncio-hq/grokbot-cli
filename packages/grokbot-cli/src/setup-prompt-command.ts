import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BOT_SETUP_PROMPT } from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import type { TextSink } from "./main.js";

/**
 * `grokbot setup-prompt [assistant|bot]`: prints a prompt for setup to happen in
 * conversation. `assistant` (the default) goes into the owner's agent runtime and follows
 * the shipped `grokbot` skill, in which the agent sets the bots' side up itself with
 * `grokbot setup-bots`. `bot` is the same prompt `setup-bots` sends, for someone with no
 * agent runtime to paste into their primary Bot's chat in the GrokBot app by hand. Local
 * like config: no network, no Keychain, no runner, never offered over MCP.
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
  "  first-time setup with you in conversation. It sets your bots' side up itself with",
  "  grokbot setup-bots (MCP: grokbot_setup_bots): your primary Bot installs grokbot on its",
  "  cloud computer and saves the grokbot-inbox skill, your agent shows you the project list",
  "  and sends your corrections, then closes the Setup check item the bot posts.",
  "bot: the fallback for someone without an agent runtime. Paste it into your primary Bot's",
  "  chat in the GrokBot app. It is the text grokbot setup-bots sends, so the bot installs",
  "  grokbot, saves the grokbot-inbox skill, lists its projects and posts one test item.",
  "Both prompts tell the bot or agent to change nothing else.",
  "",
].join("\n");

const USAGE = "Usage: grokbot setup-prompt [assistant|bot]";

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
    '3. Do the skill\'s "First-time setup" section with me, step by step. In it you set up my bots\' side yourself with `grokbot setup-bots` (over MCP, `grokbot_setup_bots`): show me the project list my primary Bot gives, send my corrections back, then wait for the "Setup check" item the bot posts and close it.',
    "",
    "During setup, send no bot any message except the ones that section allows, and hire, push, delete or change nothing on my bots.",
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
    ctx.stdout.write(`${BOT_SETUP_PROMPT}\n`);
    if (ctx.isTTY)
      ctx.stderr.write(
        "Paste this into your primary Bot's chat in the GrokBot app. With an agent, run grokbot setup-bots instead.\n",
      );
    return EXIT_CODE.ok;
  }
  const { skillPath } = ctx.deps;
  const found = await ctx.deps.exists(skillPath);
  ctx.stdout.write(setupPrompt(found ? skillPath : NPM_ROOT_SKILL, found));
  if (ctx.isTTY)
    ctx.stderr.write(
      "Paste this into your agent. It sets your bots' side up itself with grokbot setup-bots.\n",
    );
  return EXIT_CODE.ok;
}
