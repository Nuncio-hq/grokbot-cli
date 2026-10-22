/** The inbox project of the test item the bot posts and the assistant closes, proving both directions work. */
export const SETUP_CHECK_PROJECT = "Setup check";

/** Saving the bot-side skill from the installed package, the same step in setup and update. */
const SAVE_INBOX_SKILL =
  'Read "$(npm root -g)/grokbotagent-cli/skills/grokbot-inbox/SKILL.md" and save it as a skill named grokbot-inbox, replacing an older one, so all my bots can use it.';

/**
 * What the owner's primary Bot is asked to do on its cloud computer to set the bots' side of
 * grokbot up. One text for both ways it arrives: `grokbot setup-bots` sends it, and
 * `grokbot setup-prompt bot` prints it for pasting into the bot's chat by hand. It names the
 * bot-side skill through that computer's own `npm root -g`, never a path from the sender's.
 * No trailing newline: a printer adds one, a sender must not.
 */
export const BOT_SETUP_PROMPT = [
  "I'm setting up grokbot so my AI assistant and my bots can leave each other work. Please do this on your cloud computer, step by step, and tell me what happened at each step:",
  "",
  "1. Install or update grokbot: run `npm i -g grokbotagent-cli@latest`, then `grokbot --version`.",
  `2. ${SAVE_INBOX_SKILL}`,
  "3. Tell me the projects you know about and which bot looks after each. I will correct the list; remember it, and use exactly those names as the project when you post an inbox item.",
  `4. Post one test item with \`grokbot inbox-post --kind result --project "${SETUP_CHECK_PROJECT}" --title "grokbot inbox works" --expires-in 1h\`. When the header of this message has a Session or a Job, add \`--to-session <address>\` and \`--re-job <job>\` with them copied exactly. Tell me its id; my assistant will mark it done.`,
  "",
  "Change nothing else: no routines, no new bots, and no messages to anyone.",
].join("\n");

/**
 * What `grokbot update-bots` asks the primary Bot after grokbot changed on this computer:
 * install exactly `version` on the cloud computer, so both sides run the same grokbot, and
 * save the bot-side skill again from it. No trailing newline, like the setup prompt.
 */
export function botUpdatePrompt(version: string): string {
  return [
    `grokbot on my computer is now ${version}. Please update grokbot on your cloud computer to the same version, step by step, and tell me what happened at each step:`,
    "",
    `1. Run \`npm i -g grokbotagent-cli@${version}\`, then \`grokbot --version\`. It must print ${version}.`,
    `2. ${SAVE_INBOX_SKILL}`,
    "",
    "Change nothing else: no routines, no new bots, and no messages to anyone.",
  ].join("\n");
}
