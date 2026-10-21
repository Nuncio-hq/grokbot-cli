import type { InboxIssue } from "grokbot-core";

/** A flag that takes one value, and one that may repeat. */
export interface FlagSpec {
  readonly one: readonly string[];
  readonly many: readonly string[];
}

export interface ParsedFlags {
  readonly one: Readonly<Record<string, string>>;
  readonly many: Readonly<Record<string, readonly string[]>>;
  readonly positionals: readonly string[];
  readonly errors: readonly InboxIssue[];
}

/**
 * `--name value` and `--name=value`. A flag always takes the token after it as its value,
 * even one that starts with a dash (`--title "-5 is wrong"`, `--json -`). `--` ends the flags.
 */
export function parseFlags(
  args: readonly string[],
  spec: FlagSpec,
): ParsedFlags {
  const one: Record<string, string> = {};
  const many: Record<string, string[]> = {};
  const positionals: string[] = [];
  const errors: InboxIssue[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq < 0 ? undefined : eq);
    const isOne = spec.one.includes(name);
    if (!isOne && !spec.many.includes(name)) {
      errors.push({
        path: `--${name}`,
        message: "is not a flag of this command",
      });
      continue;
    }
    let value = eq < 0 ? undefined : token.slice(eq + 1);
    if (value === undefined) {
      if (i + 1 >= args.length) {
        errors.push({ path: `--${name}`, message: "needs a value" });
        continue;
      }
      value = args[++i] ?? "";
    }
    if (!isOne) many[name] = [...(many[name] ?? []), value];
    else if (name in one)
      errors.push({ path: `--${name}`, message: "was given twice" });
    else one[name] = value;
  }
  return { one, many, positionals, errors };
}

/** The object without its absent values; undefined when nothing is left. */
function compact(entries: Record<string, unknown>): object | undefined {
  const kept = Object.entries(entries).filter(
    ([, value]) =>
      value !== undefined && !(Array.isArray(value) && value.length === 0),
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** Flags that build a draft; with `--json` or `--json-file` they are refused. */
export const DRAFT_FLAGS: FlagSpec = {
  one: [
    "project",
    "kind",
    "severity",
    "title",
    "start-here",
    "done-when",
    "verify",
    "reply",
    "blocking",
    "summary",
    "body-file",
    "dedupe-key",
    "reply-to",
    "to-session",
    "re-job",
  ],
  many: ["choice", "ref", "relates-to"],
};

/** The draft a set of flags describes, and the problems with the flags themselves. */
export function draftFromFlags(
  flags: ParsedFlags,
  body: string | undefined,
): { readonly draft: object; readonly errors: readonly InboxIssue[] } {
  const { one, many } = flags;
  const errors: InboxIssue[] = [];
  const refs = (many.ref ?? []).flatMap((ref) => {
    const eq = ref.indexOf("=");
    const label = ref.slice(0, eq).trim();
    const url = ref.slice(eq + 1).trim();
    if (eq < 0 || label === "" || url === "") {
      errors.push({ path: "--ref", message: "must look like label=https://…" });
      return [];
    }
    return [{ label, url }];
  });
  const draft = compact({
    project: one.project,
    kind: one.kind,
    severity: one.severity,
    title: one.title,
    startHere: one["start-here"],
    ask: compact({
      doneWhen: one["done-when"],
      verify: one.verify,
      reply: one.reply,
      choices: many.choice,
      blocking: one.blocking,
    }),
    details: compact({ summary: body ?? one.summary }),
    refs,
    replyTo:
      one["reply-to"] === undefined ? undefined : { agentId: one["reply-to"] },
    to: compact({
      session: one["to-session"],
      job: one["re-job"],
    }),
    relatesTo: many["relates-to"],
    dedupeKey: one["dedupe-key"],
  });
  return { draft: draft ?? {}, errors };
}

const FLAG_OF_FIELD: Readonly<Record<string, string>> = {
  project: "--project",
  kind: "--kind",
  severity: "--severity",
  title: "--title",
  startHere: "--start-here",
  "ask.doneWhen": "--done-when",
  "ask.verify": "--verify",
  "ask.reply": "--reply",
  "ask.choices": "--choice",
  "ask.blocking": "--blocking",
  "details.summary": "--summary or --body-file",
  refs: "--ref",
  "replyTo.agentId": "--reply-to",
  "to.session": "--to-session",
  "to.job": "--re-job",
  relatesTo: "--relates-to",
  dedupeKey: "--dedupe-key",
};

/** The flag that sets a draft field, to name beside a validation message when flags built the draft. */
export function flagForField(path: string): string | undefined {
  const field = path.replace(/\[\d+\]/g, "").replace(/^refs\..*/, "refs");
  return FLAG_OF_FIELD[field];
}
