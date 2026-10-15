"""Build docs/reference.html from docs/grokbot-tools-and-api.json.

Run after editing the JSON:  python3 docs/build-reference.py
The JSON is the source of truth for tools and methods; this page is generated, so do not edit it by hand.
"""
import collections
import html
import json
import pathlib
import re

DOCS = pathlib.Path(__file__).resolve().parent
DATA = json.loads((DOCS / "grokbot-tools-and-api.json").read_text())
OUT = DOCS / "reference.html"

DOMAIN_ORDER = [
    ("core", "Bots and conversations", "Create and manage bots, send messages, read transcripts, tasks, routines and settings."),
    ("actions", "Actions inside a chat", "Approvals, drafts, forms, rooms, meetings, pull request chat and the bridge to your own computer."),
    ("integrations", "Integrations, credentials and payments", "Secrets, 1Password, email inboxes, plugins and skills, templates, Slack, Teams, passkeys and spending."),
    ("sandbox", "Cloud computer", "Each bot's own cloud machine (the box): start, upgrade, file store and team setup."),
    ("staff", "Staff only", "Back-office methods for GrokBot staff. Listed for completeness; your account cannot use them."),
]
SAFETY_TAG = {"read-only": ("ok", "Read-only"), "writes": ("todo", "Writes"), "destructive": ("danger", "Destructive"),
              "sensitive": ("warn", "Sensitive"), "staff-only": ("todo", "Staff only")}
EVIDENCE = DATA["evidence_levels"]


def rich(text):
    """Escape text, then turn `code` spans into <code>."""
    out = html.escape(re.sub(r"\s+", " ", text or "").strip())
    return re.sub(r"`([^`]+)`", r"<code>\1</code>", out)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def evidence_line(item):
    sure = "" if item["confidence"] == "high" else f', {item["confidence"]} confidence'
    return html.escape(EVIDENCE.get(item["evidence"], item["evidence"]) + sure)


def row(name, ev, body, tags, attrs):
    tag_html = f'<div class="mrow__tags">{"".join(tags)}</div>' if tags else ""
    return (f'<div class="mrow" {attrs}><div class="mrow__name"><code>{html.escape(name)}</code>'
            f'<span class="mrow__ev">{ev}</span></div><div class="mrow__body">{body}</div>{tag_html}</div>')


def method_row(m):
    sk, sl = SAFETY_TAG.get(m["safety"], ("todo", m["safety"]))
    tags = [f'<span class="tag tag--{sk}">{sl}</span>']
    if m.get("used_by_cli"):
        tags.append('<span class="tag tag--ok">Used by CLI</span>')
    if m.get("rpc", "unary") != "unary":
        tags.append('<span class="tag tag--todo">Stream</span>')
    io = [f'<b>Send</b> {rich(m["inputs"])}'] if m.get("inputs") else []
    if m.get("returns"):
        io.append(f'<b>Get</b> {rich(m["returns"])}')
    body = f'<p class="mrow__fn">{rich(m["function"])}</p>'
    body += f'<p class="mrow__io">{" · ".join(io)}</p>' if io else ""
    body += f'<p class="mrow__note">{rich(m["notes"])}</p>' if m.get("notes") else ""
    tested = "1" if m["evidence"] in ("probed", "probed-error") else "0"
    return row(m["name"], evidence_line(m), body, tags, f'data-safety="{html.escape(m["safety"])}" data-tested="{tested}"')


def tool_row(t):
    tags = []
    if t.get("needs_approval") == "yes":
        tags.append('<span class="tag tag--warn">Asks you first</span>')
    if not t.get("in_tool_registry", True):
        tags.append('<span class="tag tag--todo">Status only</span>')
    body = f'<p class="mrow__fn">{rich(t["function"])}</p>'
    body += f'<p class="mrow__io"><b>Shows as</b> {html.escape(t["status_label"])}</p>' if t.get("status_label") else ""
    body += f'<p class="mrow__note">{rich(t["notes"])}</p>' if t.get("notes") else ""
    return row(t["name"], evidence_line(t), body, tags, f'data-approval="{t.get("needs_approval", "unknown")}"')


methods, tools = DATA["methods"], DATA["tools"]
by_domain = collections.defaultdict(list)
for m in methods:
    by_domain[m["domain"]].append(m)
ev = collections.Counter(m["evidence"] for m in methods)
approval = sum(1 for t in tools if t.get("needs_approval") == "yes")

# ---------- tools ----------
tool_areas = collections.OrderedDict()
for t in sorted(tools, key=lambda t: t["area"].lower()):
    tool_areas.setdefault(t["area"], []).append(t)
tools_html = [
    '<section class="refsec" data-ref aria-label="All tools">',
    '<div class="ref-bar"><label class="sr-only" for="tools-q">Search tools</label>',
    '<input id="tools-q" type="search" data-q placeholder="Search tools: email, meeting, shell…" autocomplete="off">',
    '<label class="check"><input type="checkbox" data-approval-filter> Asks you first only</label>',
    '<span class="count" data-count aria-live="polite"></span></div>',
    '<nav class="ref-jump" aria-label="Tool groups">'
    + "".join(f'<a href="#tools-{slug(a)}">{html.escape(a)} <span>{len(r)}</span></a>' for a, r in tool_areas.items()) + '</nav>',
]
for area, rows in tool_areas.items():
    tools_html.append(f'<div class="area area--tools" id="tools-{slug(area)}" data-area><h3 class="area__title area__title--big">{html.escape(area)}</h3>')
    tools_html += [tool_row(t) for t in sorted(rows, key=lambda t: t["name"].lower())]
    tools_html.append("</div>")
tools_html.append('<p class="ref-empty" data-empty hidden>No tool matches. Try a shorter word or clear the filter.</p></section>')

# ---------- methods ----------
api_html = [
    '<section class="refsec" data-ref aria-label="All methods">',
    '<div class="ref-bar"><label class="sr-only" for="api-q">Search methods</label>',
    '<input id="api-q" type="search" data-q placeholder="Search methods: room, email, delete…" autocomplete="off">',
    '<label class="sr-only" for="api-safety">Safety</label><select id="api-safety" data-safety-filter><option value="">Any safety</option>'
    + "".join(f'<option value="{k}">{v[1]}</option>' for k, v in SAFETY_TAG.items()) + "</select>",
    '<label class="check"><input type="checkbox" data-tested-filter> Tested live only</label>',
    '<span class="count" data-count aria-live="polite"></span></div>',
    '<nav class="ref-jump" aria-label="Method groups">'
    + "".join(f'<a href="#api-{k}">{html.escape(t)} <span>{len(by_domain[t])}</span></a>' for k, t, _ in DOMAIN_ORDER) + "</nav>",
]
for key, title, blurb in DOMAIN_ORDER:
    items = by_domain[title]
    opened = "" if key == "staff" else " open"
    api_html.append(f'<details class="group" id="api-{key}"{opened}><summary><span class="group__title">{html.escape(title)}</span>'
                    f'<span class="group__count" data-group-count>{len(items)}</span></summary><p class="group__blurb">{html.escape(blurb)}</p>')
    areas = collections.OrderedDict()
    for m in items:
        areas.setdefault(m["area"], []).append(m)
    for area, rows in areas.items():
        api_html.append(f'<div class="area" data-area><h4 class="area__title">{html.escape(area)}</h4>')
        api_html += [method_row(m) for m in rows]
        api_html.append("</div>")
    api_html.append("</details>")
api_html.append('<p class="ref-empty" data-empty hidden>No method matches. Try a shorter word or clear the filters.</p></section>')

PAGE = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grokbot-cli · Reference ({len(tools)} Tools &amp; {len(methods)} RPCs)</title>
<meta name="description" content="Quick start, how a GrokBot request works, and every GrokBot bot tool and API method.">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="assets/site.css">
<!-- Generated by docs/build-reference.py from docs/grokbot-tools-and-api.json. Do not edit by hand. -->
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<header class="top-frame" id="top">
  <div class="container top-frame__inner">
    <a class="brand" href="index.html" aria-label="Grokbot-cli, source of truth">
      <span class="brand__dot" aria-hidden="true"></span>
      <span>Grokbot-cli</span>
      <span class="brand__sub">/ reference</span>
    </a>
    <div class="top-meta">
      <span>APP v{html.escape(DATA.get("app_version", "?"))} · CHECKED {html.escape(DATA.get("checked", "?"))}</span>
    </div>
    <div class="top-actions">
      <a class="btn-cta btn-cta--primary" href="index.html">← Back to Truth</a>
    </div>
  </div>
</header>

<nav class="floating-dock" aria-label="Reference Command Dock">
  <a class="dock-link" href="index.html">← Truth</a>
  <a class="dock-link" href="#start" data-dock-link aria-current="true">01 Quick Start</a>
  <a class="dock-link" href="#how" data-dock-link>02 How It Works</a>
  <a class="dock-link" href="#tools" data-dock-link>03 Tools ({len(tools)})</a>
  <a class="dock-link" href="#api" data-dock-link>04 API ({len(methods)})</a>
</nav>

<main id="main">
<div class="container">
  <section class="chapter" style="padding-top: var(--space-8);">
    <div class="hero-copy">
      <span class="hero-edition">Machine-Verified Catalog · GrokBot v{html.escape(DATA.get("app_version", "?"))}</span>
      <h1 class="hero-headline">Every bot tool &amp; <em>RPC method</em>, indexed.</h1>
      <p class="hero-subtext">How to use the CLI, how a GrokBot request works, and every bot tool ({len(tools)}) and API method ({len(methods)}). Architecture, roadmap, and decisions live on the <a href="index.html">truth page</a>.</p>
    </div>
  </section>

  <section class="block" id="start" aria-labelledby="start-title">
    <div class="section-head">
      <div>
        <div class="section-head__title">
          <span class="section-idx">01</span>
          <h2 id="start-title">Quick start</h2>
        </div>
        <p class="section-lead">Needs macOS and Node 20.3 or later. Sign in once with <code>grokbot login</code>, or keep the Grok Bot app signed in: without its own sign-in, grokbot reads the app's token on each call. From this repo, <code>bun packages/grokbot-cli/src/cli.ts</code> runs the same CLI from source.</p>
      </div>
    </div>
    <div class="code" style="margin-top: var(--space-5);"><pre><code><span class="c"># install, then check auth and list your bots</span>
<span class="p">$ </span>npm install -g grokbotagent-cli
<span class="p">$ </span>grokbot whoami
<span class="p">$ </span>grokbot agents

<span class="c"># give a bot a job and wait up to 10 minutes (flags go before or after the command)</span>
<span class="p">$ </span>grokbot ask "&lt;task&gt;" --agent "Primary Test" --timeout 600

<span class="c"># long job: dispatch now, wait on the job id later</span>
<span class="p">$ </span>job=$(grokbot send "&lt;task&gt;" --agent &lt;agentId&gt;)
<span class="p">$ </span>grokbot wait "$job"

<span class="c"># recent transcript, or stop the current run</span>
<span class="p">$ </span>grokbot tail -n 20 --agent &lt;agentId&gt;
<span class="p">$ </span>grokbot interrupt --agent &lt;agentId&gt;</code></pre></div>
    <p class="small muted" style="margin-top: var(--space-3);"><code>ask</code> and <code>wait</code> return once the Done Rule settles, delegations included. Exit 3 means a card awaits the owner (<code>grokbot approvals</code>); exit 4 means the wait timed out and <code>grokbot wait &lt;job&gt;</code> resumes it. For Claude Code, Hermes, Codex, or Cursor, copy <code>skills/grokbot/SKILL.md</code> from the installed package (<code>$(npm root -g)/grokbotagent-cli</code>) into the agent's skills folder. The legacy Python <code>./grokbot</code> stays in the repo; the request lifecycle below describes it.</p>
  </section>

  <section class="block" id="how" aria-labelledby="how-title">
    <div class="section-head">
      <div>
        <div class="section-head__title">
          <span class="section-idx">02</span>
          <h2 id="how-title">How a request works</h2>
        </div>
      </div>
    </div>
    <ol class="steps" style="margin-top: var(--space-5);">
      <li><h3>Read the token</h3><p>Active account's token from <code>~/Library/Application Support/Grok Bot/sand-secrets.json</code>, decrypted with the Keychain item "Grok Bot Safe Storage" (Electron safeStorage v10: PBKDF2-SHA1, salt <code>saltysalt</code>, 1003 rounds, AES-128-CBC). Never stored.</p><span class="ref">grokbot:37–66</span></li>
      <li><h3>Send the message</h3><p><code>SendGrokBotUserMessage</code> with a random <code>messageId</code>. The server accepts at once; the bot works in the background.</p><span class="ref">grokbot:127–134</span></li>
      <li><h3>Find the echo</h3><p>Every 2 s, read the transcript until our message appears (<code>clientNonce</code> = our <code>messageId</code>) and note its <code>requestId</code>.</p><span class="ref">grokbot:145–158</span></li>
      <li><h3>Wait for the reply</h3><p>Every 3 s, look for a reply with the same <code>requestId</code>. After a delegation the real answer comes in a later run, so this step returns too early.</p><span class="ref">grokbot:159–168</span></li>
    </ol>
    <div class="code" style="margin-top: var(--space-5);"><pre><code>POST https://api2.cursor.sh/aiserver.v1.GrokBotService/&lt;Method&gt;

authorization: Bearer &lt;token from the GrokBot app&gt;
origin:        https://cursor.com
content-type:  application/json</code></pre></div>
    <h3 style="margin-top: var(--space-6);">Transcript entry fields</h3>
    <dl class="fields">
      <dt>kind: message</dt><dd>A turn. <code>role</code> is user or assistant. Bot-to-bot turns carry <code>toAgent</code> or <code>fromAgent</code>.</dd>
      <dt>kind: send-message</dt><dd>A reply shown to the person. One run can post several.</dd>
      <dt>requestId</dt><dd>Groups the entries of one run. Another bot's reply starts a new run.</dd>
      <dt>clientNonce</dt><dd>Copy of the <code>messageId</code> we sent.</dd>
      <dt>seq</dt><dd>Order of entries, sent as a string number.</dd>
    </dl>
    <h3 style="margin-top: var(--space-6); margin-bottom: var(--space-3);">Traps</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Trap</th><th scope="col">What happens</th><th scope="col">Do this</th></tr></thead>
        <tbody>
          <tr><td><code>api.cursor.com</code></td><td>404.</td><td>Use <code>api2.cursor.sh</code>.</td></tr>
          <tr><td>Keychain <code>GrokOAuthTokens</code></td><td>Old Warp token; refreshing gives <code>invalid_grant</code>.</td><td>Ignore it.</td></tr>
          <tr><td><code>GetGrokBotSendStatus</code></td><td>Stays <code>ACCEPTED</code> after the reply.</td><td>Watch the transcript or bot status.</td></tr>
          <tr><td>Text that starts with a dash</td><td>Read as a flag.</td><td>Put <code>--</code> before it: <code>grokbot ask -- "-5"</code>.</td></tr>
          <tr><td>401 or 403</td><td>The sign-in expired.</td><td>Run <code>grokbot login</code>, or open the GrokBot app once.</td></tr>
          <tr><td>GrokBot app update</td><td>The API isn't publicly documented, so fields can change.</td><td>Run <code>grokbot agents</code>, then <code>grokbot ask "ping"</code> on a test bot.</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="block" id="tools" aria-labelledby="tools-title">
    <div class="section-head">
      <div>
        <div class="section-head__title">
          <span class="section-idx">03</span>
          <h2 id="tools-title">Bot tools</h2>
        </div>
        <p class="section-lead">{len(tools)} tools a GrokBot bot can call while it works. They run on GrokBot's servers; the app only shows them. {approval} ask you first. None of them deletes a bot.</p>
      </div>
    </div>
    {"".join(tools_html)}
  </section>

  <section class="block" id="api" aria-labelledby="api-title">
    <div class="section-head">
      <div>
        <div class="section-head__title">
          <span class="section-idx">04</span>
          <h2 id="api-title">API methods</h2>
        </div>
        <p class="section-lead">{len(methods)} methods on <code>aiserver.v1.GrokBotService</code>. {ev["probed"] + ev["probed-error"]} were tested live on the owner's account, {ev["app-code"]} are explained from the app's code, the others from their schema.</p>
      </div>
    </div>
    {"".join(api_html)}
  </section>
</div>
</main>
<footer class="footer">
  <div class="container footer__inner">
    <p>Generated from <code>docs/grokbot-tools-and-api.json</code> by <code>docs/build-reference.py</code>.</p>
    <div class="footer__links">
      <a href="index.html">← Back to Truth</a>
      <a href="#top">Top ↑</a>
    </div>
  </div>
</footer>
<script src="assets/reference.js"></script>
</body>
</html>
"""
OUT.write_text(PAGE)
print(f"wrote {OUT.name}: {len(tools)} tools, {len(methods)} methods")
