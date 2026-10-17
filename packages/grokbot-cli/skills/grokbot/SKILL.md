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
| 3 | Awaiting approval. A card or a computer hand-off blocks the bot. | Follow "Approval cards" below. |
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
- **Code:** repo work through Cursor cloud agents on a linked GitHub, GitLab, Bitbucket or Azure DevOps repo. They can open pull requests (`code-changes`, `source-control`). See "Cloud agents" below for choosing the model and the machine.
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

### Cloud agents: model and machine

A bot launches a Cursor cloud agent with a repo, a starting branch, a model and a place to run. Say in the brief what you want; whatever you leave out falls back to the defaults below.

- **Model:** left unset, the account's default model is used, then the team's, then Cursor's. Name a model in the brief to override it, for example "use Claude Opus 5.5". A follow-up message cannot change the model of a running agent. Per Cursor's docs, Cursor's own models draw on the plan's included usage, while other providers' models are billed at API prices.
- **Machine:** by default a Cursor-hosted Ubuntu machine, one size, Linux only. Setup lives in the repo's `.cursor/environment.json` (a Dockerfile or snapshot, plus install and start commands) or in a saved environment.
- **The owner's own machine:** a self-hosted "My Machines" worker on macOS or Linux, for example a Mac for Xcode builds. It needs no Enterprise plan and can run several agents at once. Name it in the brief by its exact worker name: "run the cloud agent on machine my-mac". The worker must be signed in to the same account the bot launches agents as (`grokbot worker-start --name <name>` does that on the owner's Mac), and its folder must hold a checkout of the repo with the same git remote. It gets no dashboard secrets and ignores `environment.json`, so tools, keys and signing certificates must already be on that machine.
- **Team pools** (`pool=<name>`) need a Cursor Enterprise plan.

A run on a My Machines worker has been tested live once (a Mac, a read-only task). The worker runs agent commands as the OS user that started it, with that user's files and logins, so prefer a dedicated machine or user. Start it without `SSH_AUTH_SOCK` (`env -u SSH_AUTH_SOCK grokbot worker-start --name <name> --yes`, owner OK first) unless agents should use the owner's SSH keys, and stop it when the work is done. Check where the agent ran in its report.

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

`grokbot` answers question widgets and resolves cloud-computer and Mac approvals. Exit 3 and `grokbot approvals` name every other blocking card and mark it "only the owner can answer this in the GrokBot app": secret requests, connector grants and connections, repo connections, Secure Forms, logins from 1Password or the vault, virtual-card purchases, use of the owner's browser logins, meeting consent, phone permissions, phone calls, bot shares and computer hand-offs. Tell the owner what the card asks and wait for them. macOS Messages access is asked on the owner's Mac and never shows as a card, so a bot stuck on an iMessage step keeps running: ask the owner to check the Mac.

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

A routine runs a bot on its own: on a schedule, on a webhook POST, on mail to its inbox, on Slack, Microsoft Teams, GitHub, Linear, Sentry or PagerDuty events (once that platform is linked to the bot), or on a group of two or more of these.

```bash
grokbot routines-list Researcher
grokbot routines-create Researcher --name "Monday digest" \
  --cron "CRON_TZ=UTC 0 9 * * 1" --prompt "Send me last week's competitor launches"
grokbot routines-create Researcher --name "CI watch" --github owner/repo --events ci-failed \
  --prompt "Find why CI failed and post the cause in #dev" --paused
grokbot routines-update Researcher "Monday digest" --cron "CRON_TZ=UTC 0 8 * * 1"
grokbot routines-disable Researcher "Monday digest"
grokbot routines-delete Researcher "Monday digest" --yes   # owner OK first
```

- Bots on GrokBot's servers (harness `temporal`, which most accounts use) can only save a routine themselves. So `routines-create` and `routines-update` send the bot one exact instruction, wait for its turn like `ask`, then read the routine back, and fail if what the bot saved differs. If the bot raises a card (for example to approve saving the routine) or the wait times out, the command exits 1 and names the job: resolve the card, then run `grokbot wait <job>` and `routines-list`. Do not send the same create again, because the first instruction may still be carried out.
- Triggers without their own flags go in `--trigger '<json>'`, for example `{"type":"slack","channel":"C123","match":{"kind":"mention"}}`. `--email <inbox>` takes `--from` senders; `name+tag@` addresses let each service wake its own routine.
- A routine cannot be started on demand on these bots (`routines-run` refuses). To start one from a script, CI or Claude, give it a webhook trigger and fire it:

```bash
grokbot routines-create Researcher --name "Deploy check" --webhook --prompt "Check the deploy named in the input and email me the result"
grokbot routines-webhook-key Researcher "Deploy check" --yes   # owner OK first: mints a key into the macOS Keychain
grokbot routines-fire Researcher "Deploy check" --payload '{"deploy":"web-42"}'
```

- The key stays in the Keychain and is never printed. `routines-webhook-key` is sensitive and CLI only: never run it without the owner's OK. `--replace` mints a new key but does not revoke the old one; only deleting the routine ends its keys, and `routines-delete` also removes the Keychain item.
- `routines-fire` returns once GrokBot accepts the POST, and the run sees the JSON body. A run's own output cannot be read, so the routine's prompt must say where to post the result: "Post one message in your main chat with the owner saying …" lands in the bot's chat a few seconds after the run (read it with `grokbot tail`); a Slack channel or an email also works. GrokBot pauses a bot's routines when nobody reads their results.
- GrokBot pauses routines while the owner is away, so a schedule can stop without warning; check `routines-list` now and then.
- Live coverage (17 Oct 2026): a webhook routine was created, renamed, keyed, fired and deleted through `grokbot`. Cron, email, GitHub and `--trigger` routines pass the same checks against the app's trigger shapes but were not run, and a platform trigger needs that platform linked to the bot. Check the result with `routines-list`.

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
| `grokbot routines-delete <agent> <routine> [--force-protected <string>] [--yes]` | destructive, needs --yes | Delete a bot's routine, and its webhook key in the Keychain |
| `grokbot routines-create <agent> --name <string> --prompt <string> [--cron <string>] [--webhook] [--email <string>] [--from <string>...] [--require-auth-pass] [--github <string>] [--events <string>...] [--ci-branch <string>] [--pr <integer>] [--trigger <string>] [--trigger-file <string>] [--paused] [--force-protected <string>] [--timeout <integer>]` | writes | Create a routine for a bot: on a schedule, webhook, email, GitHub event, or any trigger as JSON |
| `grokbot routines-update <agent> <routine> [--name <string>] [--prompt <string>] [--cron <string>] [--webhook] [--email <string>] [--from <string>...] [--require-auth-pass] [--github <string>] [--events <string>...] [--ci-branch <string>] [--pr <integer>] [--trigger <string>] [--trigger-file <string>] [--force-protected <string>] [--timeout <integer>]` | writes | Change a bot's routine: its name, prompt, or trigger |
| `grokbot routines-run <agent> <routine>` | writes | Run a routine now, with your sign-in; only bots on the Cloud Box (others: routines-fire) |
| `grokbot routines-webhook-key <agent> <routine> [--force-protected <string>] [--replace] [--yes]` | sensitive, needs --yes | Mint a webhook routine's key into the macOS Keychain; it is never printed |
| `grokbot routines-fire <agent> <routine> [--payload <string>] [--payload-file <string>]` | writes | Fire a webhook routine with the key in the Keychain and an optional JSON body |
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
