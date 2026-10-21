# grokbot-cli

Work with your [Grok Bot](https://cursor.com/docs/grok-bot) bots from a terminal or from any agent runtime (Claude Code, Codex, Cursor, omp, Hermes and others): brief a bot and wait for its real answer, reply to one of its messages, answer approval cards, hire bots, and manage skills and routines.

| Package | What it is |
|---|---|
| [`grokbotagent-cli`](https://www.npmjs.com/package/grokbotagent-cli) | The `grokbot` command and the agent skill it ships |
| [`grokbot-mcp`](https://www.npmjs.com/package/grokbot-mcp) | The same commands as an MCP server |
| [`grokbot-core`](https://www.npmjs.com/package/grokbot-core) | The TypeScript SDK both are built on |

## Install

Needs macOS and Node 20.3 or later.

```bash
npm install -g grokbotagent-cli
grokbot login      # or keep the Grok Bot desktop app signed in; grokbot uses its login
grokbot agents     # lists your bots: you are connected
```

On a network that needs a proxy, set `GROKBOT_HTTPS_PROXY=http://host:port` (or the usual `HTTPS_PROXY`) before running `grokbot`.

## Set it up

Run this and paste what it prints into your agent runtime, once:

```bash
grokbot setup-prompt
```

The prompt points your agent at the skill that ships with `grokbot` and walks you through first-time setup together: it checks your sign-in, shows your bots and which one is your primary Bot, asks which bots are your main and test bots, asks your primary Bot once how your account is organised, and routes each of your project folders to the bot that owns that project. It changes nothing on your bots without asking you first.

Your agent then sets up your bots' side itself with `grokbot setup-bots` (over MCP, `grokbot_setup_bots`). Your primary Bot installs `grokbot` on its cloud computer, saves the `grokbot-inbox` skill so all your bots know how to leave work for your assistant, and lists the projects it knows. Your agent shows you that list and sends your corrections back, then waits for the "Setup check" item the bot posts and closes it to prove the two sides can reach each other.

No agent runtime, or you would rather do it by hand? Run this and paste what it prints into your primary Bot's chat in the GrokBot app instead. It is the same text `grokbot setup-bots` sends:

```bash
grokbot setup-prompt bot
```

## Use it

```bash
grokbot ask "Summarise yesterday's merged PRs" --timeout 600   # waits for the bot's final reply
job=$(grokbot send --agent Researcher "Compare our pricing with three competitors")
grokbot wait "$job" --timeout 1800                              # resume any job later
grokbot reply "$job" "Shorter, please"                          # like Reply in the app
grokbot team                                                    # who is running, idle, or waiting on you
grokbot inbox                                                   # what your bots left for your assistant
grokbot --help                                                  # every command
```

Without `--agent`, a message goes to the bot routed to the current folder (`grokbot config route`), else to your primary Bot.

Your bots leave items for your assistant (a bug to fix, a task, a question, a result to check) in an inbox on their cloud computer. Your assistant sees them about a minute later with `grokbot inbox`, even if your computer was asleep, and answers with `grokbot inbox-reply` or `grokbot inbox-done`. Decisions, money and public posts still go to you in the GrokBot app.

Every message your assistant sends starts with a short header naming the project, the agent runtime, its session and the job, so a bot can address an item to exactly the session that asked. Your assistant waits for such items with `grokbot inbox wait` instead of checking again and again (in the background, when its runtime can run a command there), and any other `grokbot` command mentions new ones. If your agent runtime can run a command before the agent stops, have it run `grokbot inbox check`: a session then never finishes with an item for it unseen.

## Use it over MCP

```bash
npm install -g grokbot-mcp
```

Add a stdio server named `grokbot` with the command `grokbot-mcp` to your agent runtime's MCP settings.

## Safety

- `grokbot` never prints your token, and it keeps its own sign-in in the macOS Keychain.
- Commands that delete something, approve a card, or are otherwise sensitive need `--yes`; bots you mark with `grokbot config protect` cannot be deleted or changed by accident.
- Try new things on a test bot first.

## More

- [Command and API reference](docs/reference.html) (open the file in a browser)
- [Project overview, decisions and log](docs/index.html)
- [The agent skill](packages/grokbot-cli/skills/grokbot/SKILL.md)

## License

[MIT](LICENSE)
