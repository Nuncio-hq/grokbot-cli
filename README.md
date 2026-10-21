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

## Set it up with your agent

Run this once and paste what it prints into your agent runtime:

```bash
grokbot setup-prompt
```

The prompt points your agent at the skill that ships with `grokbot` and walks you through first-time setup together: it checks your sign-in, shows your bots and which one is your primary Bot, asks which bots are your main and test bots, asks your primary Bot once how your account is organised, and, with your OK, routes each of your project folders to the bot that owns that project. It changes nothing on your bots without asking you first.

## Use it

```bash
grokbot ask "Summarise yesterday's merged PRs" --timeout 600   # waits for the bot's final reply
job=$(grokbot send --agent Researcher "Compare our pricing with three competitors")
grokbot wait "$job" --timeout 1800                              # resume any job later
grokbot reply "$job" "Shorter, please"                          # like Reply in the app
grokbot team                                                    # who is running, idle, or waiting on you
grokbot --help                                                  # every command
```

Without `--agent`, a message goes to the bot routed to the current folder (`grokbot config route`), else to your primary Bot.

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
