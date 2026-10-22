# Grokbot-cli — Agent Guide

**Read `docs/index.html` first. It is the single source of truth** (visual architecture, decisions, 4-phase roadmap, verified capabilities, rules, open questions, log). `docs/reference.html` has the CLI quick start, request lifecycle, and every GrokBot tool and API method; `docs/grokbot-tools-and-api.json` is the machine-searchable catalog.

**Use the words in its Vocabulary** (`docs/index.html#vocabulary`) in code comments, docs, the shipped skill, messages to bots and chat: an *agent* works in a *runtime* (Claude Code, Codex, Hermes…), *GrokBot* is the application, *grokbot-cli* is ours, and a *bot* lives inside GrokBot, even where the API calls it an agent.

## Workspace Layout (Bun Monorepo · MIT License · `Nuncio-hq/grokbot-cli`)

| Path | Purpose |
|---|---|
| `packages/grokbot-core` | npm `grokbot-core`: TypeScript SDK, Keychain auth, RPC client, `WatchGrokBotTranscripts` stream, Done Rule, and single tool catalog |
| `packages/grokbot-cli` | npm `grokbotagent-cli`: `grokbot` CLI binary (renders from `grokbot-core`) |
| `packages/grokbot-mcp` | npm `grokbot-mcp`: thin stdio MCP server (renders from `grokbot-core`) |
| `README.md` | What people see on GitHub: install, `grokbot setup-prompt`, a few commands, links |
| `packages/grokbot-cli/skills/grokbot/SKILL.md` | Agent skill shipped in the CLI package, for any agent runtime; its command table is generated (`bun run gen:skill`) and a test fails on drift |
| `grokbot` | Legacy Python stdlib CLI prototype (kept for the owner; agents use the TS CLI) |
| `docs/index.html` | Visual source of truth (decisions, roadmap, verified facts, rules, log) |
| `docs/grokbot-tools-and-api.json` | Canonical data for 148 bot tools & 338 RPC methods (`python3 docs/build-reference.py` generates `docs/reference.html`) |

## One-way Dependencies & Verification Gate

- **Dependency rule**: `packages/grokbot-cli` and `packages/grokbot-mcp` depend on `packages/grokbot-core`, never the reverse. Tool definitions live once in `packages/grokbot-core`.
- **Single verify gate**: Run `bun run verify` (Biome lint/format check, TypeScript `tsc -b`, Vitest unit tests, `docs/reference.html` sync check, and package build).
- **Live smoke check**: Run `bun packages/grokbot-cli/src/cli.ts agents` (read-only) to verify auth. The CLI imports `grokbot-core` from its `dist`, so run `bun run typecheck` or `bun run build` first after core changes. Only run `bun packages/grokbot-cli/src/cli.ts ask "ping" --agent f882ec52-17b1-4639-b0fc-07fed7526b09 --timeout 120` when changing live message-send or stream-wait code, to avoid spamming `Primary Test`.
- **After a GrokBot app update**: run `bun run check:app` (versions only) and `bun run check:app --diff` (downloads the catalog's version of the app and diffs schema, tools, Box Gateway and gates; `--current latest` uses the update feed instead of the installed app), then update `docs/grokbot-tools-and-api.json` for every gap it lists. The weekly `App watch` workflow (`.github/workflows/app-watch.yml`) runs the same check and opens one `app-update` issue per newer version.

## Hard Rules (Full list in `docs/index.html#rules`)

- **Public open-source repo.** `Nuncio-hq/grokbot-cli` is public (MIT): every commit, message and line of history is visible to anyone. Never commit tokens, keys, signed/VNC/gateway URLs, personal emails or phone numbers, private host or machine names, tailnet names or IPs, or raw transcript text with private data. Use placeholders (`example-mac`, "a private model server"). Scan the staged diff before every commit.
- **Any agent, any purpose.** grokbot-cli is a product for every GrokBot user, driven from any agent runtime, script, CI job or app, for any purpose. Code, the shipped skill and docs never privilege one runtime (naming several in an example list is fine) and never carry one account or business: no bot ids or names, machine names, playbooks or runtime-only glue. Account data goes in user config (`grokbot config`); runtime glue and anyone's own setup live outside this repo. A maintainer may keep their own deployment notes as git-excluded skills under `.agents/skills/` (excluded through `.git/info/exclude`); read them when present, never commit them.
- **No Markdown files.** Record facts, decisions, plan status, questions, and log entries in `docs/index.html`. Two exceptions: the shipped product skills under `packages/grokbot-cli/skills/` (`grokbot` for assistant sessions, `grokbot-inbox` for bots), and the root `README.md` (owner, 20 Oct 2026), which only tells people how to install and set up grokbot and points to the docs; it holds no plans, status or log. This file (`AGENTS.md`) stays a short pointer + rules. `CLAUDE.md` is a symlink here; edit `AGENTS.md`, never `CLAUDE.md`.
- **Zero secret leaks.** Never print, commit, store, or log the GrokBot token, Keychain output, window tokens, or `sand-secrets.json` contents. One owner-approved exception (15 Oct 2026): `grokbot login` keeps its own sign-in in the macOS Keychain item `grokbot-cli`, never in a file.
- **Safety tags.** Check `docs/grokbot-tools-and-api.json` before calling a new RPC method. Never call methods tagged `destructive`, `sensitive`, or `staff-only` without the owner's OK.
- **Test only on test bots**: bots marked `test` in `grokbot config` (the maintainer's are `Primary Test` `f882ec52-17b1-4639-b0fc-07fed7526b09` and `Staff Test` `201a8cb2-e34a-4dd6-858c-c8601d5c2aa5`), never on a bot marked `main`. Always pass `--agent` in live checks: without it (and without `GROKBOT_AGENT` or a project route) `grokbot` goes to the account's primary Bot.
- **Language & git.** Reply to the owner in the language they write in; code, comments, and docs in English. Conventional commits, no AI references, commit only when asked.
- **Releases.** Only through the on-demand `Release` workflow on `main` (`gh workflow run release.yml -f bump=patch`, `-f dry_run=true` to rehearse), and only when the owner asks. Never bump versions by hand with a global replace.
- **Docs sync.** After editing `docs/grokbot-tools-and-api.json`, always run `python3 docs/build-reference.py`.
