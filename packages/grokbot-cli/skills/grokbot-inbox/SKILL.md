---
name: grokbot-inbox
description: For a GrokBot bot running on its cloud computer. Leaves a structured item (bug, task, question, result or decision) for the assistant sessions on the owner's computer, which read it later through the server, and closes it when the work is done. Use when you need a coding or computer-side assistant to fix, check, answer or look at something and it can wait for a session to pick it up.
---

# Leave an item for the owner's assistants

Assistant sessions on the owner's computer check an inbox when they start and before they finish. You write into that inbox from your own computer with `grokbot`, no network login needed. The item appears for them about a minute later, even if the owner's computer is asleep now.

## Install once

```bash
grokbot inbox-schema >/dev/null 2>&1 || npm i -g grokbotagent-cli@latest
```

Node 20 or later. The check installs or updates `grokbot` when the inbox commands are missing, including an older version without them. Nothing here needs a sign-in: these commands only write files on your own computer.

## When to post, and when to tell the owner

Post an item when **a session can act on it later**: a bug in code or a tool on the owner's computer, a task for a session, a question a live session could answer, or a result worth checking.

Tell the owner in your chat, as well as or instead of an item, for anything that is theirs to decide:

- **Decisions** and approvals. You may add a `decision` item so sessions know it is open, but sessions never answer it: only the owner does.
- **Money**: anything that costs or spends.
- **Public posts**: anything sent or published under the owner's name or yours.
- Secrets, logins and sign-ins.

Never put a secret in an item. `inbox-post` refuses any text that looks like a credential (keys, tokens, private key blocks) and names the field.

## Kinds and severities

| Kind | Use it for | Needs |
| --- | --- | --- |
| `bug` | something broken | `ask.doneWhen` |
| `task` | work to do | `ask.doneWhen` |
| `question` | you need an answer; only for a session that is live now, it expires in 2 days | optional `ask.choices` (2 to 6) |
| `result` | work finished, to check or use; expires in 7 days | |
| `decision` | a choice only the owner makes | |

Bugs, tasks and decisions expire after 14 days. Severity is `low`, `normal` (the default), `high` or `critical`. Use `critical` only when something is down or losing data now.

## Post with a JSON draft

Pipe one draft to `inbox-post`. It prints JSON with the item's `id` and path, or, on a refusal, exits 2 with `{"ok":false,"errors":[{"path":"…","message":"…"}]}` naming each field to fix. `grokbot inbox-schema` prints the full JSON Schema.

```bash
grokbot inbox-post --json - <<'JSON'
{
  "project": "Acme Web",
  "kind": "bug",
  "severity": "high",
  "title": "Checkout returns 500 for carts with a coupon",
  "startHere": "curl -i https://example.com/api/cart/preview?coupon=SPRING",
  "ask": {
    "doneWhen": "the request above returns 200 with the discounted total",
    "verify": "npm test -- cart"
  },
  "details": {
    "observed": "500 with 'coupon is undefined' in the log",
    "expected": "200 and a total reduced by the coupon",
    "repro": ["add any item to a cart", "apply coupon SPRING", "open checkout"],
    "alreadyChecked": ["the coupon exists and is active"]
  },
  "dedupeKey": "checkout-coupon-500"
}
JSON
```

One example per other kind, as the draft's fields:

- `task`: `{"project":"Acme Web","kind":"task","title":"Add the new logo to the footer","startHere":"/workspace/acme/assets/logo.svg","ask":{"doneWhen":"the footer shows the new logo on every page"}}`
- `question` (a live session can answer): `{"project":"Acme Web","kind":"question","title":"Keep the old API route?","ask":{"choices":["keep it","remove it"],"blocking":"the cleanup waits on this"}}`
- `result`: `{"project":"Acme Web","kind":"result","severity":"low","title":"Weekly dependency audit done","startHere":"/workspace/acme/reports/audit.md","details":{"summary":"3 updates are safe, 1 needs a major upgrade."}}`
- `decision`: `{"project":"Acme Web","kind":"decision","title":"Move hosting to the cheaper plan?","details":{"summary":"Saves a little each month, loses nothing today."}}`

Flags work too, for a short item: `--project --kind --severity --title --start-here --done-when --verify --reply --choice (repeat) --blocking --summary --body-file <path|-> --ref label=url (repeat) --file <path> (repeat) --dedupe-key --relates-to <id> (repeat) --reply-to <agentId> --to-session <address> --re-job <job> --expires-in 1h..30d`. `--file` attaches a file (up to 10 files, 10 MB in all) and can be combined with `--json`.

`startHere` is the one command or URL to open first. Say where things are with `work`, so a session does not hunt:

```json
"work": {
  "state": "in-progress",
  "trail": [
    { "at": "cloud-computer", "path": "/workspace/acme", "did": "reproduced it and found the failing line" }
  ],
  "latest": { "at": "repo", "url": "https://github.com/example/acme", "branch": "fix-coupon" },
  "next": {
    "by": "session",
    "at": "owner-computer",
    "machine": { "id": "<machine id>", "label": "<short computer name>" },
    "path": "/Users/example/code/acme",
    "action": "apply the patch in the branch and run the tests",
    "command": "git fetch && git switch fix-coupon",
    "needs": ["owner-computer-awake", "session"]
  }
}
```

- A **place** is `{ "at": <where>, … }`, and `at` is always required. Where: `owner-computer` (with `machine` {id, label} and/or an absolute `path`), `cloud-computer` (a `path` under `/workspace` or `/home`), `cloud-agent` (`cloudAgentId` `bc-…` and/or `url`), `bot` (`agentId`), `repo` (https `url`, optional `branch`, `commit`, `pr`), `web` (https `url`).
- `work.state`: `not-started`, `in-progress`, `blocked`, `done`. `trail` is up to 5 steps, each a place plus `did`. `latest` is the one place the work stands now. `next` is a place plus `by` (`session`, `bot` or `owner`), an `action`, a `command` and `needs`.
- `needs` takes: `owner-computer-awake`, `session`, `owner-approval`, `owner-payment`, `owner-sign-in`, `secret`, `teammate-bot`, `cloud-agent-finished`, `review`.
- A session sees "this computer, your turn" only when `next` is at an `owner-computer` whose `machine.label` is its own computer's short name. Use the label the owner's computer shows in your tools; with no label known, give the `path` and say so in `action`.

Limits: title 100 characters; `startHere`, each `ask` field, `action` and each list line 300 (`command` 500); `summary` 4000; `repro` and `alreadyChecked` up to 20 lines; up to 10 `refs`.

## Limits that keep the inbox useful

- **One open item per problem.** Give every item a `dedupeKey` (lowercase letters, digits, `.`, `_`, `-`, up to 80). Posting the same key again updates the open item instead of adding another.
- **About 3 posts a day per project**, unless something is critical. Put several findings into one `result`, not one item each.
- **Questions only for a live session.** If nobody can answer within 2 days, decide yourself, or tell the owner in chat.
- Update, don't repost: `grokbot inbox-update <id> --note "…" [--severity high] [--state in-progress]`.

## Address the session that wrote to you

Every message an assistant sends you starts with a header like `[Project: Acme Web · Runtime: omp · Session: omp:<id>]`. When the message is about one job that session sent, the header ends with `· Job: <job>` (8 characters). Each part is there only when known. An `[inbox …]` message ends its bracket with the runtime and the address instead, `· omp · omp:<id>`: that address is its Session.

Copy the `Session` and the `Job` from the header of the message your item answers into `--to-session <address>` and `--re-job <job>` (or `"to": {"session": "<address>", "job": "<job>"}` in a JSON draft), exactly: never guess or build either. The session sees an item for it (or for its job) first, marked "for this session"; other sessions still list it, marked "for another session". When the header names neither, post to the project as before.

## Close what is finished

A session that finishes an item sends you a message in your chat, `[inbox <id> · <project> · done: <outcome>]` (the bracket may end with ` · <runtime> · <address>`) with a reason and a link when it has them, and `answer: <choice>` or `reply` for the others. When you see a done message, or when you judge the work finished yourself, close the item:

```bash
grokbot inbox-close <id> --outcome fixed --reason "Merged and deployed" --ref https://github.com/example/acme/pull/42
```

`--outcome` is one of `fixed`, `answered`, `done`, `wont-fix`, `duplicate`, `superseded`, `handed-off`. `--reason` (300 characters) and `--ref` (an https link) are optional. Items you leave open expire on their own, and closed ones are deleted after 30 days.
