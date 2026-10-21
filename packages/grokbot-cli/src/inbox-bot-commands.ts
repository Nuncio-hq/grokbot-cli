import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  INBOX_EXPIRES_IN,
  INBOX_ITEM_JSON_SCHEMA,
  INBOX_KINDS,
  INBOX_NEEDS,
  INBOX_OUTCOMES,
  INBOX_PLACES,
  INBOX_ROOT,
  INBOX_ROOT_ENV,
  INBOX_SEVERITIES,
  INBOX_WORK_STATES,
  type InboxFailure,
  type InboxGit,
  type InboxIssue,
  inboxGitInfo,
  inboxStore,
  parseInboxExpiresIn,
} from "grokbot-core";
import { EXIT_CODE } from "./exit-codes.js";
import {
  DRAFT_FLAGS,
  draftFromFlags,
  type FlagSpec,
  flagForField,
  type ParsedFlags,
  parseFlags,
} from "./inbox-bot-flags.js";
import type { TextSink } from "./main.js";

/**
 * The commands a bot runs on its cloud computer to leave items in the inbox. Local like
 * setup-prompt: no network, no Keychain, no runner, never offered over MCP. They only
 * read and write the inbox folder, so they work on Linux.
 */
export const INBOX_BOT_COMMANDS = [
  "inbox-post",
  "inbox-update",
  "inbox-close",
  "inbox-schema",
] as const;
export type InboxBotCommand = (typeof INBOX_BOT_COMMANDS)[number];

export const isInboxBotCommand = (
  name: string | undefined,
): name is InboxBotCommand => INBOX_BOT_COMMANDS.some((c) => c === name);

export const INBOX_BOT_SUMMARIES: Readonly<Record<InboxBotCommand, string>> = {
  "inbox-post":
    "Leave an item (bug, task, question, result, decision) for the owner's assistants",
  "inbox-update": "Add a note to an open inbox item",
  "inbox-close": "Close an inbox item with an outcome",
  "inbox-schema": "Print the JSON Schema of an inbox item",
};

const PLACE_LINE = `A place is {"at": ${INBOX_PLACES.join("|")}, plus path, url, machine, agentId...}.`;

export const INBOX_BOT_HELP: Readonly<Record<InboxBotCommand, string>> = {
  "inbox-post": [
    INBOX_BOT_SUMMARIES["inbox-post"],
    "",
    "Usage: grokbot inbox-post <flags>",
    "       grokbot inbox-post --json - [--file <path>]... [--expires-in <n>h|<n>d]  (JSON draft on stdin)",
    "       grokbot inbox-post --json-file <path> [--file <path>]...",
    "",
    "Run it from a GrokBot bot's command (it needs CURSOR_CONVERSATION_ID and CURSOR_REQUEST_ID).",
    `The item is written under ${INBOX_ROOT} (override with ${INBOX_ROOT_ENV}).`,
    "",
    "Flags:",
    "  --project <text>        Project the item belongs to (required, up to 60 characters)",
    `  --kind <kind>           ${INBOX_KINDS.join(", ")} (required)`,
    `  --severity <level>      ${INBOX_SEVERITIES.join(", ")} (default: normal)`,
    "  --title <text>          One line, up to 100 characters (required)",
    "  --start-here <text>     The one command or URL to open first",
    "  --done-when <text>      What makes it done (required for a bug and a task)",
    "  --verify <text>         How to check it is done",
    "  --reply <text>          What to answer, and in what form",
    "  --choice <text>         An answer a question allows (repeat 2 to 6 times; question only)",
    "  --blocking <text>       What is blocked until this is answered",
    "  --summary <text>        Details, up to 4000 characters",
    "  --body-file <path|->    Read the details from a file, or - for stdin",
    "  --ref <label=url>       A link (repeat, up to 10)",
    "  --file <path>           Copy a file into the item (repeat, up to 10, 10 MB together)",
    "  --dedupe-key <key>      Posting again with the same key in the same project updates the open item",
    "  --relates-to <id>       Id of a related item (repeat)",
    "  --reply-to <agentId>    Send the answer to this bot instead of you",
    "  --to-session <address>  Address the item to one assistant session: the Session address from the header of its message, copied exactly",
    "  --re-job <job>        Address the item to one job of a session: the Job from the header of the message it answers, copied exactly",
    `  --expires-in <n>h|<n>d  Keep it open this long (${INBOX_EXPIRES_IN.minHours}h to ${INBOX_EXPIRES_IN.maxDays}d); default by kind`,
    "  --json -                Read the whole draft as JSON from stdin (cannot combine with the flags above, except --file and --expires-in)",
    "  --json-file <path>      Read the whole draft as JSON from a file",
    "",
    "A JSON draft holds the item fields you write; grokbot stamps the rest. Its other fields:",
    "  startHere, ask {doneWhen, verify, reply, choices, blocking}, details {summary, observed, expected,",
    "  repro[], alreadyChecked[], firstSeenAt, occurrences}, work {state, trail[], latest, next},",
    `  refs[], replyTo {agentId}, to {session, job}, relatesTo[], dedupeKey. ${PLACE_LINE}`,
    `  work.state: ${INBOX_WORK_STATES.join(", ")}; work.next.needs: ${INBOX_NEEDS.join(", ")}.`,
    "  Run grokbot inbox-schema for the full schema. Never put a secret in an item.",
    "",
    "Output (stdout, always JSON):",
    '  {"ok": true, "id", "project", "slug", "path", "deduped", "openInProject", "expired": [{"id", "project", "title"}]}',
    '  Refused: exit 2, {"ok": false, "errors": [{"path", "message"}]}',
    "",
  ].join("\n"),
  "inbox-update": [
    INBOX_BOT_SUMMARIES["inbox-update"],
    "",
    "Usage: grokbot inbox-update <id> --note <text> [--severity <level>] [--state <state>]",
    "",
    "Flags:",
    "  --note <text>        What changed, up to 300 characters (required)",
    `  --severity <level>   ${INBOX_SEVERITIES.join(", ")}`,
    `  --state <state>      Work state: ${INBOX_WORK_STATES.join(", ")}`,
    "",
    "Appends the note to the item's updates (the last 20 are kept) and bumps updatedAt.",
    'Output: {"ok": true, "id", "project", "slug", "path", "openInProject", "expired": [...]}',
    "An unknown or closed id exits 1.",
    "",
  ].join("\n"),
  "inbox-close": [
    INBOX_BOT_SUMMARIES["inbox-close"],
    "",
    "Usage: grokbot inbox-close <id> --outcome <outcome> [--reason <text>] [--ref <https url>]",
    "",
    "Flags:",
    `  --outcome <outcome>  ${INBOX_OUTCOMES.join(", ")} (required)`,
    "  --reason <text>      Why, up to 300 characters",
    "  --ref <url>          An https link to the result (a pull request, a page)",
    "",
    "Moves the item to closed/. Open items past their expiry and closed items older than",
    "30 days are cleaned up on every post, update and close.",
    'Output: {"ok": true, "id", "project", "slug", "path", "openInProject", "expired": [...]}',
    "An unknown or already closed id exits 1.",
    "",
  ].join("\n"),
  "inbox-schema": [
    INBOX_BOT_SUMMARIES["inbox-schema"],
    "",
    "Usage: grokbot inbox-schema",
    "",
    "Prints JSON Schema (2020-12) of an item file. A draft holds the properties not marked",
    "readOnly; grokbot stamps those.",
    "",
  ].join("\n"),
};

/** Everything the commands touch besides the inbox folder, injectable so tests need no real stdin or git. */
export interface InboxBotDeps {
  readonly cwd: string;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readStdin(): Promise<string>;
  readText(path: string): Promise<string>;
  git(cwd: string): Promise<InboxGit | undefined>;
}

export function defaultInboxBotDeps(): InboxBotDeps {
  return {
    cwd: process.cwd(),
    async readStdin() {
      if (process.stdin.isTTY)
        throw new Error("no input: pipe the text into stdin");
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    readText: (path) => readFile(path, "utf8"),
    git: inboxGitInfo,
  };
}

interface InboxBotContext {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly deps: InboxBotDeps;
}

const POST_FLAGS: FlagSpec = {
  one: [...DRAFT_FLAGS.one, "json", "json-file", "expires-in"],
  many: [...DRAFT_FLAGS.many, "file"],
};
const UPDATE_FLAGS: FlagSpec = { one: ["note", "severity", "state"], many: [] };
const CLOSE_FLAGS: FlagSpec = { one: ["outcome", "reason", "ref"], many: [] };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Reports problems as JSON on stdout and one line on stderr; returns the exit code. */
function refuse(
  ctx: InboxBotContext,
  name: InboxBotCommand,
  errors: readonly InboxIssue[],
  code: number = EXIT_CODE.usage,
): number {
  ctx.stdout.write(json({ ok: false, errors }));
  const [first, ...more] = errors;
  if (first) {
    const extra = more.length > 0 ? ` (+${more.length} more)` : "";
    ctx.stderr.write(
      `grokbot: ${name}: ${first.path}: ${first.message}${extra}\n`,
    );
  }
  return code;
}

const failureCode = (failure: InboxFailure) =>
  failure.kind === "invalid" ? EXIT_CODE.usage : EXIT_CODE.failure;

const text = (value: string | undefined) => value?.trim() || undefined;

/** The draft from `--json`, `--json-file` or the flags, with the files and expiry that go with it. */
async function readDraft(
  flags: ParsedFlags,
  deps: InboxBotDeps,
): Promise<
  | { readonly draft: unknown; readonly viaFlags: boolean }
  | { readonly errors: readonly InboxIssue[] }
> {
  const { one } = flags;
  const jsonValue = one.json;
  const jsonFile = one["json-file"];
  const given = DRAFT_FLAGS.one
    .filter((flag) => one[flag] !== undefined)
    .concat(
      DRAFT_FLAGS.many.filter((flag) => (flags.many[flag] ?? []).length > 0),
    )
    .map((flag) => `--${flag}`);

  if (jsonValue !== undefined || jsonFile !== undefined) {
    if (jsonValue !== undefined && jsonFile !== undefined)
      return {
        errors: [
          { path: "--json-file", message: "cannot be combined with --json" },
        ],
      };
    if (jsonValue !== undefined && jsonValue !== "-")
      return {
        errors: [
          {
            path: "--json",
            message:
              "takes - (read the draft from stdin); use --json-file for a file",
          },
        ],
      };
    if (given.length > 0)
      return {
        errors: given.map((path) => ({
          path,
          message: "cannot be combined with a JSON draft; put it in the draft",
        })),
      };
    const flag = jsonValue === undefined ? "--json-file" : "--json";
    let source: string;
    try {
      source =
        jsonFile === undefined
          ? await deps.readStdin()
          : await deps.readText(resolve(deps.cwd, jsonFile));
    } catch {
      return { errors: [{ path: flag, message: "cannot be read" }] };
    }
    try {
      return { draft: JSON.parse(source) as unknown, viaFlags: false };
    } catch {
      return { errors: [{ path: flag, message: "is not valid JSON" }] };
    }
  }

  const bodyFile = one["body-file"];
  if (bodyFile !== undefined && one.summary !== undefined)
    return {
      errors: [
        { path: "--body-file", message: "cannot be combined with --summary" },
      ],
    };
  let body: string | undefined;
  if (bodyFile !== undefined) {
    try {
      body = (
        bodyFile === "-"
          ? await deps.readStdin()
          : await deps.readText(resolve(deps.cwd, bodyFile))
      ).trim();
    } catch {
      return { errors: [{ path: "--body-file", message: "cannot be read" }] };
    }
  }
  const { draft, errors } = draftFromFlags(flags, body);
  return errors.length > 0 ? { errors } : { draft, viaFlags: true };
}

async function post(
  args: readonly string[],
  ctx: InboxBotContext,
): Promise<number> {
  const name = "inbox-post";
  const { env, deps } = ctx;
  const flags = parseFlags(args, POST_FLAGS);
  const errors: InboxIssue[] = [...flags.errors];
  for (const extra of flags.positionals)
    errors.push({
      path: extra,
      message: "is not expected; pass values with flags",
    });
  const agentId = text(env.CURSOR_CONVERSATION_ID);
  const run = text(env.CURSOR_REQUEST_ID);
  for (const [key, value] of [
    ["CURSOR_CONVERSATION_ID", agentId],
    ["CURSOR_REQUEST_ID", run],
  ] as const)
    if (value === undefined)
      errors.push({
        path: `env.${key}`,
        message: "is not set; run this from a GrokBot bot's command",
      });
  let expiresInMs: number | undefined;
  const expiresIn = flags.one["expires-in"];
  if (expiresIn !== undefined) {
    const parsed = parseInboxExpiresIn(expiresIn);
    if (parsed.ok) expiresInMs = parsed.ms;
    else errors.push({ path: "--expires-in", message: parsed.message });
  }
  if (errors.length > 0 || agentId === undefined || run === undefined)
    return refuse(ctx, name, errors);

  const source = await readDraft(flags, deps);
  if ("errors" in source) return refuse(ctx, name, source.errors);

  const git = await deps.git(deps.cwd);
  const store = inboxStore({
    env,
    ...(deps.now && { now: deps.now }),
    ...(deps.randomId && { randomId: deps.randomId }),
  });
  const result = await store.post({
    draft: source.draft,
    files: (flags.many.file ?? []).map((path) => resolve(deps.cwd, path)),
    from: { agentId, run, cwd: deps.cwd, ...(git && { git }) },
    ...(expiresInMs !== undefined && { expiresInMs }),
  });
  if (!result.ok) {
    const shown = source.viaFlags
      ? result.errors.map((e) => {
          const flag = flagForField(e.path);
          return flag ? { ...e, message: `${e.message} (${flag})` } : e;
        })
      : result.errors;
    return refuse(ctx, name, shown, failureCode(result));
  }
  ctx.stdout.write(
    json({
      ok: true,
      id: result.id,
      project: result.project,
      slug: result.slug,
      path: result.path,
      deduped: result.deduped,
      openInProject: result.openInProject,
      expired: result.expired,
    }),
  );
  return EXIT_CODE.ok;
}

async function itemCommand(
  name: "inbox-update" | "inbox-close",
  args: readonly string[],
  ctx: InboxBotContext,
): Promise<number> {
  const { env, deps } = ctx;
  const flags = parseFlags(
    args,
    name === "inbox-update" ? UPDATE_FLAGS : CLOSE_FLAGS,
  );
  const [id, ...extra] = flags.positionals;
  const errors: InboxIssue[] = [...flags.errors];
  if (id === undefined)
    errors.push({
      path: "id",
      message: "is required: the item id comes first",
    });
  for (const value of extra)
    errors.push({ path: value, message: "is not expected" });
  if (errors.length > 0 || id === undefined) return refuse(ctx, name, errors);
  const store = inboxStore({
    env,
    ...(deps.now && { now: deps.now }),
    ...(deps.randomId && { randomId: deps.randomId }),
  });
  const { one } = flags;
  const result =
    name === "inbox-update"
      ? await store.update({
          id,
          note: one.note ?? "",
          ...(text(env.CURSOR_REQUEST_ID) && {
            run: text(env.CURSOR_REQUEST_ID),
          }),
          ...(one.severity !== undefined && { severity: one.severity }),
          ...(one.state !== undefined && { state: one.state }),
        })
      : await store.close({
          id,
          outcome: one.outcome ?? "",
          by: text(env.CURSOR_CONVERSATION_ID) ?? "grokbot",
          ...(one.reason !== undefined && { reason: one.reason }),
          ...(one.ref !== undefined && { ref: one.ref }),
        });
  if (!result.ok) return refuse(ctx, name, result.errors, failureCode(result));
  ctx.stdout.write(
    json({
      ok: true,
      id: result.id,
      project: result.project,
      slug: result.slug,
      path: result.path,
      openInProject: result.openInProject,
      expired: result.expired,
    }),
  );
  return EXIT_CODE.ok;
}

/** Runs one bot-side inbox command and returns its exit code. */
export async function runInboxBotCommand(
  name: InboxBotCommand,
  args: readonly string[],
  ctx: InboxBotContext,
): Promise<number> {
  try {
    if (name === "inbox-schema") {
      if (args.length > 0)
        return refuse(ctx, name, [
          { path: args[0] ?? "", message: "is not expected" },
        ]);
      ctx.stdout.write(json(INBOX_ITEM_JSON_SCHEMA));
      return EXIT_CODE.ok;
    }
    return name === "inbox-post"
      ? await post(args, ctx)
      : await itemCommand(name, args, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(ctx, name, [{ path: "inbox", message }], EXIT_CODE.failure);
  }
}
