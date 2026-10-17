---
name: grokbot
description: Works with GrokBot bots from the shell through the grokbot CLI. Briefs bots and waits for their replies, resolves approval cards, hires bots, runs multi-bot rooms, manages the Box-wide skill library (grokbot-managed and user-managed skills) and routines (schedules, webhooks, email and app events), and calls Box MCP tools. Use when the user mentions GrokBot or Grok Bot, their bots, handing work to a bot, a bot's email inbox, routines or webhooks that wake a bot, approval cards, or the grokbot command.
---

# GrokBot workforce

GrokBot bots are always-on assistants, each with its own cloud computer, memory and connectors. You and the owner decide the work together. Hand a bot what benefits from being always on, from its computer or from its connectors, brief it well, check what it sends back, and bring the owner in for anything that needs their approval.

## Rules

1. Never pass `--yes` unless the owner approved that exact action in this conversation. The Safety column in the command table marks every command that needs it.
2. Run experiments, smoke tests, and anything you are unsure of on a test bot. On the owner's account those are `Primary Test` and `Staff Test`. If the account has neither, ask the owner which bot you may use. Never experiment on `Grok Bot`, the owner's main bot.
3. `grokbot` refuses to fire `Grok Bot`, `Primary Test`, or `Staff Test`, or to change their skills and routines, unless the command carries `--force-protected <full agentId>`. Never add that flag on your own.
4. Never print, log, or paste a token, Keychain output, or the link `grokbot vnc --print-url` returns. Do not read `sand-secrets.json` or run `security find-generic-password`. `grokbot` never prints a token, so nothing you need is there.
5. The skill library is Box-wide. `skills-push` and `skills-remove` change what every bot sees, whichever bot you name.

## Setup check

```bash
grokbot whoami   # which sign-in grokbot uses; exits 1 when there is none
grokbot agents   # the roster; this call proves auth and the backend work
```

If `grokbot` is missing, install it with `npm install -g grokbotagent-cli` (Node 20.3 or later, macOS). If `whoami` exits 1, ask the owner to run `grokbot login`. It opens a sign-in page only the owner can finish. The Grok Bot desktop app's login also works.

`--agent` takes a bot's name, slug, or agentId. `GROKBOT_AGENT` sets the default bot. Workforce commands take the bot as their first argument instead.

## Dispatch work

A task that finishes within a few minutes:

```bash
grokbot ask --agent "Primary Test" "Summarise yesterday's merged PRs" --timeout 600
```

A long task, so your shell stays free:

```bash
job=$(grokbot send --agent Researcher "Compare our pricing with the top three competitors")
grokbot wait "$job" --timeout 1800
```

`ask` and `wait` return when the Done Rule settles. The bot's turn has ended, every bot it delegated to has finished, and a final reply exists. A room turn prints one `Name: text` line per member. Done means the bot's run for your message ended. It does not mean the task is verified, so check the reply against what you asked for.

You can send several messages to one bot. `grokbot` gives a bot one of your messages at a time, so each job gets its own reply. A message sent while the bot is busy is queued: `send` still prints its job id, and stderr says it is queued. It goes out when the bot is free and some `send`, `ask` or `wait` on that bot runs, and a `wait` that finishes one job sends the next. So always `wait` on every job you send. To run tasks in parallel, send them to different bots.

A message typed in the app while your job runs can still share a run with it. Both jobs then end with exit 5.

Read the exit code:

| Exit | Meaning | Next step |
| --- | --- | --- |
| 0 | Done. The final reply is on stdout. | Use it. |
| 1 | Error. stderr says what failed. | Fix the cause or tell the owner. |
| 2 | Usage error. stderr prints the usage line. | Fix the arguments. |
| 3 | Awaiting approval. A card blocks the bot. | Follow "Approval cards" below. |
| 4 | Still running, or still queued, after `--timeout`. stdout is the job id. | `grokbot wait <job>` resumes it. |
| 5 | Ambiguous. One run answered this message together with another, such as one typed in the app. stdout has every reply of that run, in order. stderr says which message it shared. | Pick the reply that answers your task, or ask again once the bot is idle. |
| 130 | Interrupted. stderr has `Resume with: grokbot wait <job>`. | Resume it. |

`send` prints the job id on stdout. `ask` writes `job <id>` to stderr as soon as the message is sent, even with `--json`. Keep the id, because `grokbot wait <id>` is the only way back to the job.

Add `--json` when you parse output. stdout is then one JSON document, and job ids and errors stay on stderr. Put `--` before text that starts with a dash: `grokbot ask -- "-5 is my answer"`.

`grokbot team` shows who is running, idle, or waiting on the owner. `grokbot tail -n 20 --agent X` shows a bot's recent transcript. `grokbot interrupt --agent X` stops its current run.

## Brief a bot

A bot does its best work from a brief that states:

- One goal, and what "done" looks like.
- The hard limits, such as "read-only", "contact no one", "spend nothing", or a word limit.
- Where the truth lives: a Notion page, a repo, an account, a file.
- The format you want back, and whether you want progress notes or one final answer.
- "Use your own computer unless I name my Mac." Mac tools need the owner's approval for each action, so they fail where there is no one to ask, such as a routine.
- "Reply in this chat." `grokbot` waits on the bot's main chat, and an answer posted in a task thread can be missed.
- "When you finish, send one message with the result, and say plainly if it is only drafted, waiting for approval, blocked, or still running."

Never ask a bot to add a connector or install a plugin in the same message as the task. It must first ask the owner, so the task stalls. Prefer one bot to a room: in a room every member processes every message, which costs more usage, and a member may pass without replying.

## What a bot can do

Most of a bot's abilities are reached by asking it in chat, not through a `grokbot` command. The list below comes from the GrokBot app (0.71.2) and the bots' built-in skills. Not every item has been run through `grokbot`, so check the result.

- **Research:** web search and reading pages, plus whatever the account's connectors reach.
- **Its own computer:** a Linux machine with a shell, files and a signed-in browser and desktop, for sites with no connector (`box-desktop`, `no-connector-fallback`). Logins it cannot finish go to the owner (`sign-in`). The owner can watch with `grokbot vnc`.
- **Code:** repo work through Cursor cloud agents on a linked GitHub, GitLab, Bitbucket or Azure DevOps repo. They can open pull requests (`code-changes`, `source-control`).
- **Background work:** subagents run while the bot keeps answering chat. `ask` and `wait` count them, so a job is not done until they finish.
- **Routines:** work on a schedule or when an event arrives. See "Routines" below.
- **Its own email inbox:** a bot can claim an address and send and read mail as itself (`agent-email`). Mail wakes a bot only through an email-trigger routine.
- **Messages as the owner:** drafts or sends email and chat messages as the owner, with approval for each one (`send-on-behalf`). It can also live in Slack or Microsoft Teams as its own app (`channels`).
- **The owner's Mac:** commands, file reads, copying files to and from its own computer, and iMessage. Each action needs the owner's approval.
- **Meetings and voice:** joins Google Meet or Zoom calls, reads transcripts and summaries, answers voice memos, and takes live voice chats and phone calls (`voice`). Joining a meeting with other people and placing a call both need approval.
- **Documents and media:** documents and live canvases beside the chat, decks (`slides`, `office-pptx`), and image and video generation. Files come back as attachments; `tail` shows their names.
- **Memory and skills:** keeps facts between chats, saves a repeated task as a skill (`skill-authoring`), learns a task the owner demonstrates once (`learn-from-demonstration`), and exports its whole setup as a shareable template (`export-bot-template`).
- **Forms and purchases:** shows the owner a form in chat for logins, addresses or codes (`in-chat-forms`), and buys things only after the owner confirms (`purchases`).

Anything that sends, posts, spends, deletes or acts on the Mac goes through an approval card or an automatic safety check.

## Approval cards

Exit 3 means a bot is waiting on the owner.

```bash
grokbot approvals                          # open cards on every bot
grokbot answer "Use the EU region" --agent Researcher
grokbot answer --dismiss --agent Researcher
grokbot approve --agent Researcher --yes   # only after the owner says yes
grokbot deny --agent Researcher --yes
grokbot wait "$job"                        # then resume the job
```

Show the owner what the card asks before you approve or deny it. Answer a question widget yourself only with facts the owner gave you or the task settles; otherwise ask the owner. `approve --always` allows that action from then on, so use it only when the owner asks for it. With more than one open card, pass `--card <id>` from `approvals`.

`grokbot` handles question widgets, cloud-computer and Mac approvals, and secret requests. Other cards only the owner can answer, in the GrokBot app: connector grants, repo connections, forms, virtual cards, 1Password requests, Messages access, phone calls, meeting consent and computer hand-offs. If a job exits 3 and `grokbot approvals` lists nothing, or lists a card it cannot answer, tell the owner to open the bot in the app.

## Manage the workforce

```bash
grokbot hire Researcher --title "Market researcher" \
  --description "Finds and summarises competitor launches" --instructions-file brief.txt
grokbot update Researcher --instructions-file brief.txt
grokbot room-create "Launch room" --member Researcher --member Writer
grokbot ask --agent "Launch room" "Draft the launch plan"
grokbot room-members "Launch room" --member Researcher,Writer,Designer
grokbot fire Researcher --yes              # owner OK first
```

`hire` gives each bot its own `/workspace/staff/<slug>` folder. Running it again with the same name re-briefs that bot and keeps its instructions unless you pass new ones.

Skills live in one Box-wide library. The bot you name only routes the call, and every change applies to all bots. `skills-list` sorts them into two types:

- **grokbot-managed** (source `managed`): built into GrokBot, such as `routines`, `agent-email`, `voice`, `sign-in` and the booking and shopping playbooks. GrokBot keeps them current; the set can differ by account or region. Read their descriptions to learn what a bot can already do.
- **user-managed** (source `plugin` or `workflow`): `plugin` skills arrive with a connector the account installed, and `workflow` skills are the account's own imports. Another account has them only if it installs the same connector or imports the same file.

To steer a bot, name the skill in your message: "Follow your routines skill." `skills-remove` and `skills-run` act on imported (`workflow`) skills only; `--include-managed` widens them to every other skill, so leave that flag to the owner. `skills-push` never overwrites a grokbot-managed or plugin skill.

```bash
grokbot skills-list "Primary Test"
grokbot skills-push "Primary Test" ./weekly-report/SKILL.md
grokbot skills-run "Primary Test" weekly-report
grokbot skills-push "Primary Test" ./weekly-report/SKILL.md --replace --yes   # owner OK first
grokbot skills-remove "Primary Test" weekly-report --yes                       # owner OK first
```

Pushing a skill whose name and content already match changes nothing.

### Routines

A routine runs a bot on its own, on a schedule or when an event arrives. `routines-create` makes schedule (cron) routines:

```bash
grokbot routines-list Researcher
grokbot routines-create Researcher --name "Monday digest" \
  --cron "CRON_TZ=Australia/Adelaide 0 9 * * 1" --prompt "Send me last week's competitor launches"
grokbot routines-disable Researcher "Monday digest"
grokbot routines-delete Researcher "Monday digest" --yes   # owner OK first
```

The app also supports routines that fire on:

- a webhook: each one gets its own URL and a sender key, sent as `Authorization: Bearer <key>`. Only the owner can copy the key, from the routine's panel in the app. Keep it in a secret store, never in chat, logs or a repo.
- email to the bot's own inbox, filtered by sender. `name+tag@` addresses let each service wake its own routine.
- Slack, Microsoft Teams, GitHub (pull requests, reviews, CI), Linear, Sentry or PagerDuty events, once that platform is linked to the bot.
- a group of two or more of these.

For any of these, ask the bot in chat to create the routine paused and to follow its `routines` skill. Saving a routine shows the owner a card, and the owner turns it on. GrokBot pauses routines while the owner is away, so a schedule can stop without warning; check `routines-list` now and then.

`skills-run`, `routines-create` and the event triggers have not been run through `grokbot` against a live account yet. Check the result with `skills-list` or `routines-list`.

## Box tools and computers

```bash
grokbot computers                          # machines registered to run bot requests
grokbot mcp-list                           # Box MCP servers and their tool counts
grokbot mcp-call <server> <tool> --args '{"query":"open bugs"}' --yes   # owner OK first
grokbot vnc --window 3                     # opens a bot's live desktop in the owner's browser
grokbot worker-plan                        # prints the worker command; starts nothing
```

`mcp-call` acts with the owner's authority, so it needs `--yes`. Leave `worker-start` to the owner, because it runs a worker in the foreground as their account.

## Limits worth knowing

- Files the owner uploads to a bot: 25 MiB each, 200 files, 1 GiB in all.
- Secrets have UPPER_SNAKE names and values of 8 bytes to 4 KiB. Put logins and keys in secrets or the vault, never in a message.
- One live voice chat at a time.
- Usage is metered weekly. A run that fails, for example on a usage or rate limit or a team policy, ends with exit 1 and `failed its turn: <reason>` on stderr. Tell the owner instead of retrying.

## Command reference

`<x>` is required and `[x]` is optional. A flag ending in `...` repeats or takes a comma-separated list. Every command also takes `--json`. `grokbot <command> --help` prints each flag's description.

<!-- BEGIN generated command table: bun run gen:skill -->
| Command | Safety | What it does |
| --- | --- | --- |
| `grokbot agents` | read-only | List GrokBot agents on the account |
| `grokbot team` | read-only | List agents with live running/idle/awaiting status |
| `grokbot ask <text> [--timeout <integer>] [--agent <string>]` | writes | Send a prompt and wait until the Done Rule settles |
| `grokbot send <text> [--agent <string>]` | writes | Dispatch a message, or queue it while the bot is busy, and return a resumable job id |
| `grokbot wait <job> [--timeout <integer>]` | read-only | Wait for a dispatched job id to finish |
| `grokbot tail [-n <integer>] [--agent <string>]` | read-only | Read recent decoded transcript entries |
| `grokbot interrupt [--agent <string>]` | writes | Interrupt the active run on an agent |
| `grokbot hire <name> --title <string> --description <string> [--instructions <string>] [--instructions-file <string>]` | writes | Create a bot with a role and its own /workspace/staff folder |
| `grokbot update <agent> [--title <string>] [--description <string>] [--instructions <string>] [--instructions-file <string>]` | writes | Change a bot's title, description, or instructions |
| `grokbot fire <agent> [--force-protected <string>] [--yes]` | destructive, needs --yes | Delete a bot or room |
| `grokbot room-create <name> --member <string>... [--description <string>]` | writes | Create a room where several bots answer one message |
| `grokbot room-members <room> --member <string>...` | writes | Set the bots in a room |
| `grokbot skills-list <agent>` | read-only | List the Box-wide (all bots) skill library, read through one bot |
| `grokbot skills-push <agent> [file] [--markdown <string>] [--name <string>] [--replace] [--yes]` | writes | Import a SKILL.md into the Box-wide (all bots) skill library; --replace --yes overwrites an imported copy |
| `grokbot skills-remove <agent> <skill> [--include-managed] [--force-protected <string>] [--yes]` | destructive, needs --yes | Delete an imported skill from the Box-wide (all bots) skill library |
| `grokbot skills-run <agent> <skill> [--include-managed]` | writes | Start an imported skill from the Box-wide (all bots) library on one bot (untested live) |
| `grokbot routines-list <agent>` | read-only | List a bot's routines with trigger and next run |
| `grokbot routines-enable <agent> <routine> [--force-protected <string>]` | writes | Turn a bot's routine on |
| `grokbot routines-disable <agent> <routine> [--force-protected <string>]` | writes | Turn a bot's routine off |
| `grokbot routines-delete <agent> <routine> [--force-protected <string>] [--yes]` | destructive, needs --yes | Delete a bot's routine |
| `grokbot routines-create <agent> --name <string> --cron <string> --prompt <string>` | writes | Create a cron routine for a bot (untested live) |
| `grokbot approvals [--agent <string>]` | read-only | List open approval cards for one agent or every agent |
| `grokbot answer [value] [--agent <string>] [--card <string>] [--dismiss]` | writes | Answer or dismiss a bot's question widget |
| `grokbot approve [--agent <string>] [--card <string>] [--always] [--yes]` | sensitive, needs --yes | Approve an auto-review or local-tool permission card |
| `grokbot deny [--agent <string>] [--card <string>] [--yes]` | sensitive, needs --yes | Deny an auto-review or local-tool permission card |
| `grokbot computers` | read-only | List the computers registered to run bot requests |
| `grokbot mcp-list` | read-only | List the Box MCP servers and their tool counts |
| `grokbot mcp-call <server> <tool> [--args <string>] [--yes]` | sensitive, needs --yes | Call one Box MCP tool and print its result |
| `grokbot vnc --window <integer> [--print-url]` | writes | Open one live desktop window on the box (VNC) |
| `grokbot worker-plan [--name <string>]` | read-only | Show the exact worker command and env names without starting it |
| `grokbot worker-start [--name <string>] [--yes]` | sensitive, needs --yes | Start a self-hosted cursor-agent worker as the GrokBot account |
| `grokbot login [--no-browser] [--api-key]` | account, local only | Sign grokbot in through the browser (own Keychain sign-in) |
| `grokbot logout` | account, local only | Remove grokbot's own sign-in (the app's login is untouched) |
| `grokbot whoami` | account, local only | Show which sign-in grokbot uses, never the token |
| `grokbot stats [--since <7d\|30d\|90d\|all>] [--bots]` | local; --bots reads GrokBot | Show how grokbot was used, from its local usage log (--bots adds message counts) |
<!-- END generated command table -->

## Usage log

`grokbot` keeps a usage log on this computer only (`~/.grokbot/usage`, about 90 days). Each run records the command, who ran it (a person, Claude Code, Codex, Cursor, Hermes, a script), how it ended and how long it took. It never records messages, replies, bot names or ids. `grokbot stats` reads it. Claude Code is recognised by itself; if your runtime is not, set `GROKBOT_CLIENT` (for example `codex` or `hermes`) so your runs are counted as yours. The owner can turn the log off with `grokbot config usage off` or `GROKBOT_USAGE=off`.

## When to use MCP instead

Use the CLI whenever you can run shell commands. Use the `grokbot-mcp` server when your runtime has no shell, or when the host already runs it. Register it as a stdio server with `npx -y grokbot-mcp`. Its tools are the commands above, renamed `grokbot_<command>` with dashes turned into underscores, such as `grokbot_ask` and `grokbot_skills_list`. Over MCP:

- `grokbot_ask` and `grokbot_wait` wait 45 seconds by default, so a host never kills the call. If the bot is still working, the result says so and gives the job id. Call `grokbot_wait` again with that id until the job is done.
- A finished result has status `done` or `ambiguous`, the MCP form of exit 0 and exit 5.
- Destructive and sensitive tools take `yes: true`, with the same owner-approval rule.
- `worker-start`, `--force-protected`, `--include-managed`, `--print-url`, and file-path arguments are CLI only. `grokbot_skills_push` takes the SKILL.md text as `markdown`.
- `login`, `logout`, and `whoami` are CLI only.
