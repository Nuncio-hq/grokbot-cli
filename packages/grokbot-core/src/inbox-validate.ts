import { credentialKind } from "./inbox-secrets.js";
import {
  INBOX_DEFAULT_SEVERITY,
  INBOX_DRAFT_FIELDS,
  INBOX_JOB_MAX_LENGTH,
  INBOX_JOB_PATTERN,
  INBOX_KINDS,
  INBOX_LIMITS,
  INBOX_NEEDS,
  INBOX_NEXT_BY,
  INBOX_PLACE_FIELD_ORDER,
  INBOX_PLACE_FIELDS,
  INBOX_PLACE_LOCATORS,
  INBOX_PLACES,
  INBOX_SEVERITIES,
  INBOX_STAMPED_FIELDS,
  INBOX_WORK_STATES,
  type InboxAsk,
  type InboxDetails,
  type InboxDraft,
  type InboxKind,
  type InboxLink,
  type InboxMachine,
  type InboxNeed,
  type InboxNext,
  type InboxPlace,
  type InboxPlaceAt,
  type InboxTrailStep,
  type InboxWork,
} from "./inbox-types.js";
import { normalizeAgentId } from "./protected-bots-store.js";
import {
  parseSessionAddress,
  SESSION_ADDRESS_MAX_LENGTH,
} from "./session-address.js";

/** One problem with a draft: `path` names the field (`work.next.needs[1]`), `message` says why. */
export interface InboxIssue {
  readonly path: string;
  readonly message: string;
}

export type InboxValidation =
  | { readonly ok: true; readonly item: InboxDraft }
  | { readonly ok: false; readonly errors: readonly InboxIssue[] };

type Obj = { readonly [key: string]: unknown };

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ [key]: value }`, or `{}` when there is no value, so spreads never add an empty key. */
function opt<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  // A computed key types as an index signature; the return type is the precise shape.
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

const join = (base: string, key: string) =>
  base === "" ? key : `${base}.${key}`;
const index = (base: string, i: number) => `${base}[${i}]`;
const list = (values: readonly string[]) => values.join(", ");

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ITEM_ID = /^[a-z0-9]{8}$/;
const JOB_REF = new RegExp(INBOX_JOB_PATTERN);
const NEEDS_SESSION_OR_JOB =
  "needs a session or a job: set session, job, or both";
const DEDUPE_KEY = /^[a-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{7,64}$/i;
const CLOUD_AGENT_ID = /^bc-[A-Za-z0-9_-]{1,96}$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const hasControlChar = (value: string, allowLineBreaks: boolean) => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (allowLineBreaks && (code === 0x0a || code === 0x0d || code === 0x09))
      continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Collects every problem, so a poster fixes a draft in one round. */
class Reader {
  readonly errors: InboxIssue[] = [];

  fail(path: string, message: string): undefined {
    this.errors.push({ path, message });
    return undefined;
  }

  private missing(path: string, required: boolean | undefined): undefined {
    return required ? this.fail(path, "is required") : undefined;
  }

  /** Trimmed text of 1..max characters, or undefined when blank. Credentials are refused here. */
  text(
    raw: unknown,
    path: string,
    max: number,
    flags: { readonly required?: boolean; readonly oneLine?: boolean } = {},
  ): string | undefined {
    if (raw === undefined || raw === null)
      return this.missing(path, flags.required);
    if (typeof raw !== "string") return this.fail(path, "must be a string");
    const value = raw.trim();
    if (value === "") return this.missing(path, flags.required);
    const length = [...value].length;
    if (length > max)
      return this.fail(
        path,
        `is ${length} characters; at most ${max} are allowed`,
      );
    if (hasControlChar(value, flags.oneLine !== true))
      return this.fail(path, "must not contain control characters");
    if (flags.oneLine && /[\r\n\u2028\u2029]/.test(value))
      return this.fail(path, "must be a single line");
    const credential = credentialKind(value);
    if (credential !== undefined)
      return this.fail(
        path,
        `looks like a credential (${credential}); never post secrets, say where to find them instead`,
      );
    return value;
  }

  choice<T extends string>(
    raw: unknown,
    values: readonly T[],
    path: string,
    required = false,
  ): T | undefined {
    if (raw === undefined || raw === null || raw === "")
      return this.missing(path, required);
    if (typeof raw !== "string")
      return this.fail(path, `must be one of: ${list(values)}`);
    const value = raw.trim() as T;
    if (!values.includes(value))
      return this.fail(
        path,
        `${JSON.stringify(raw)} is not allowed; use one of: ${list(values)}`,
      );
    return value;
  }

  httpsUrl(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, INBOX_LIMITS.url, { oneLine: true });
    if (text === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return this.fail(path, "must be an https URL");
    }
    if (url.protocol !== "https:" || url.hostname === "" || /\s/.test(text))
      return this.fail(path, "must be an https URL");
    if (url.username !== "" || url.password !== "")
      return this.fail(path, "must not carry a username or password");
    return text;
  }

  isoUtc(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, 40, { oneLine: true });
    if (text === undefined) return undefined;
    if (!ISO_UTC.test(text) || Number.isNaN(Date.parse(text)))
      return this.fail(
        path,
        "must be an ISO UTC time like 2026-10-20T11:30:00Z",
      );
    return text;
  }

  /** The object at `path`, or undefined when absent, empty or not an object. */
  object(
    raw: unknown,
    path: string,
    keys: readonly string[],
    stamped: readonly string[] = [],
  ): Obj | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isObj(raw)) return this.fail(path, "must be an object");
    for (const key of Object.keys(raw)) {
      if (keys.includes(key)) continue;
      this.fail(
        join(path, key),
        stamped.includes(key)
          ? "is set by grokbot; leave it out"
          : `is not a field here; use: ${list(keys)}`,
      );
    }
    return Object.keys(raw).length === 0 ? undefined : raw;
  }

  array<T>(
    raw: unknown,
    path: string,
    max: number,
    read: (item: unknown, itemPath: string) => T | undefined,
  ): T[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) return this.fail(path, "must be an array");
    if (raw.length > max)
      return this.fail(
        path,
        `has ${raw.length} items; at most ${max} are allowed`,
      );
    const items = raw.flatMap((item, i) => {
      const value = read(item, index(path, i));
      return value === undefined ? [] : [value];
    });
    return items.length > 0 ? items : undefined;
  }

  /** A list of non-blank texts: a blank or null element is an error at its index. */
  strings(
    raw: unknown,
    path: string,
    max: number,
    each: number,
    oneLine = false,
  ): string[] | undefined {
    return this.array(raw, path, max, (item, p) =>
      this.text(item, p, each, { required: true, oneLine }),
    );
  }

  draft(raw: unknown): InboxDraft | undefined {
    if (!isObj(raw)) return this.fail("draft", "must be a JSON object");
    const o = this.object(raw, "", INBOX_DRAFT_FIELDS, INBOX_STAMPED_FIELDS);
    if (o === undefined) return undefined;
    const project = this.text(o.project, "project", INBOX_LIMITS.project, {
      required: true,
      oneLine: true,
    });
    const kind = this.choice(o.kind, INBOX_KINDS, "kind", true);
    const severity =
      this.choice(o.severity, INBOX_SEVERITIES, "severity") ??
      INBOX_DEFAULT_SEVERITY;
    const title = this.text(o.title, "title", INBOX_LIMITS.title, {
      required: true,
      oneLine: true,
    });
    const startHere = this.text(o.startHere, "startHere", INBOX_LIMITS.text);
    const ask = this.ask(o.ask, kind);
    const details = this.details(o.details, kind);
    const work = this.work(o.work);
    const refs = this.array(o.refs, "refs", INBOX_LIMITS.refs, (item, p) =>
      this.link(item, p),
    );
    const replyTo = this.replyTo(o.replyTo);
    const to = this.to(o.to);
    const relatesTo = this.array(
      o.relatesTo,
      "relatesTo",
      INBOX_LIMITS.relatesTo,
      (item, p) => this.itemId(item, p),
    );
    const dedupeKey = this.dedupeKey(o.dedupeKey);
    if (project === undefined || kind === undefined || title === undefined)
      return undefined;
    return {
      project,
      kind,
      severity,
      title,
      ...opt("startHere", startHere),
      ...opt("ask", ask),
      ...opt("details", details),
      ...opt("work", work),
      ...opt("refs", refs),
      ...opt("replyTo", replyTo),
      ...opt("to", to),
      ...opt("relatesTo", relatesTo && [...new Set(relatesTo)]),
      ...opt("dedupeKey", dedupeKey),
    };
  }

  private ask(raw: unknown, kind: InboxKind | undefined): InboxAsk | undefined {
    const o = this.object(raw, "ask", [
      "doneWhen",
      "verify",
      "reply",
      "choices",
      "blocking",
    ]);
    const text = (key: string) =>
      this.text(o?.[key], `ask.${key}`, INBOX_LIMITS.text);
    const doneWhen = text("doneWhen");
    const verify = text("verify");
    const reply = text("reply");
    const choices = this.strings(
      o?.choices,
      "ask.choices",
      INBOX_LIMITS.choicesMax,
      INBOX_LIMITS.choice,
      true,
    );
    const blocking = text("blocking");
    if (choices !== undefined) {
      if (kind !== undefined && kind !== "question")
        this.fail("ask.choices", 'is only for kind "question"');
      else if (choices.length < INBOX_LIMITS.choicesMin)
        this.fail(
          "ask.choices",
          `needs at least ${INBOX_LIMITS.choicesMin} choices`,
        );
    }
    if (
      (kind === "bug" || kind === "task") &&
      doneWhen === undefined &&
      !this.errors.some((e) => e.path === "ask" || e.path === "ask.doneWhen")
    )
      this.fail(
        "ask.doneWhen",
        `is required for kind "${kind}": say what makes it done`,
      );
    const ask: InboxAsk = {
      ...opt("doneWhen", doneWhen),
      ...opt("verify", verify),
      ...opt("reply", reply),
      ...opt("choices", choices),
      ...opt("blocking", blocking),
    };
    return Object.keys(ask).length > 0 ? ask : undefined;
  }

  private details(
    raw: unknown,
    kind: InboxKind | undefined,
  ): InboxDetails | undefined {
    const o = this.object(raw, "details", [
      "summary",
      "observed",
      "expected",
      "repro",
      "alreadyChecked",
      "firstSeenAt",
      "occurrences",
    ]);
    const summary = this.text(
      o?.summary,
      "details.summary",
      INBOX_LIMITS.summary,
    );
    const observed = this.text(
      o?.observed,
      "details.observed",
      INBOX_LIMITS.observed,
    );
    const expected = this.text(
      o?.expected,
      "details.expected",
      INBOX_LIMITS.expected,
    );
    const repro = this.strings(
      o?.repro,
      "details.repro",
      INBOX_LIMITS.listItems,
      INBOX_LIMITS.listItem,
    );
    const alreadyChecked = this.strings(
      o?.alreadyChecked,
      "details.alreadyChecked",
      INBOX_LIMITS.listItems,
      INBOX_LIMITS.listItem,
    );
    const firstSeenAt = this.isoUtc(o?.firstSeenAt, "details.firstSeenAt");
    const occurrences = this.occurrences(o?.occurrences);
    if (kind !== undefined && kind !== "bug") {
      if (firstSeenAt !== undefined)
        this.fail("details.firstSeenAt", 'is only for kind "bug"');
      if (occurrences !== undefined)
        this.fail("details.occurrences", 'is only for kind "bug"');
    }
    const details: InboxDetails = {
      ...opt("summary", summary),
      ...opt("observed", observed),
      ...opt("expected", expected),
      ...opt("repro", repro),
      ...opt("alreadyChecked", alreadyChecked),
      ...opt("firstSeenAt", firstSeenAt),
      ...opt("occurrences", occurrences),
    };
    return Object.keys(details).length > 0 ? details : undefined;
  }

  private occurrences(raw: unknown): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1)
      return this.fail(
        "details.occurrences",
        "must be an integer of at least 1",
      );
    return raw;
  }

  private work(raw: unknown): InboxWork | undefined {
    const o = this.object(raw, "work", ["state", "trail", "latest", "next"]);
    const state = this.choice(o?.state, INBOX_WORK_STATES, "work.state");
    const trail = this.array(
      o?.trail,
      "work.trail",
      INBOX_LIMITS.trail,
      (item, p) => this.trailStep(item, p),
    );
    const latest = this.place(o?.latest, "work.latest");
    const next = this.next(o?.next);
    const work: InboxWork = {
      ...opt("state", state),
      ...opt("trail", trail),
      ...opt("latest", latest),
      ...opt("next", next),
    };
    return Object.keys(work).length > 0 ? work : undefined;
  }

  private trailStep(raw: unknown, path: string): InboxTrailStep | undefined {
    const head = this.placeHead(raw, path, ["did", "asOf"]);
    if (head === undefined) return undefined;
    const place = this.placeFields(head.o, head.at, path);
    const did = this.text(head.o.did, join(path, "did"), INBOX_LIMITS.text, {
      required: true,
      oneLine: true,
    });
    const asOf = this.isoUtc(head.o.asOf, join(path, "asOf"));
    if (place === undefined || did === undefined) return undefined;
    return { ...place, did, ...opt("asOf", asOf) };
  }

  private next(raw: unknown): InboxNext | undefined {
    const path = "work.next";
    const head = this.placeHead(raw, path, [
      "by",
      "action",
      "command",
      "needs",
    ]);
    if (head === undefined) return undefined;
    const place = this.placeFields(head.o, head.at, path);
    const by = this.choice(head.o.by, INBOX_NEXT_BY, join(path, "by"), true);
    const action = this.text(
      head.o.action,
      join(path, "action"),
      INBOX_LIMITS.text,
    );
    const command = this.text(
      head.o.command,
      join(path, "command"),
      INBOX_LIMITS.command,
      { oneLine: true },
    );
    const needs = this.array(
      head.o.needs,
      join(path, "needs"),
      INBOX_NEEDS.length,
      (item, p) => this.choice<InboxNeed>(item, INBOX_NEEDS, p, true),
    );
    if (place === undefined || by === undefined) return undefined;
    return {
      ...place,
      by,
      ...opt("action", action),
      ...opt("command", command),
      ...opt("needs", needs && [...new Set(needs)]),
    };
  }

  private place(raw: unknown, path: string): InboxPlace | undefined {
    const head = this.placeHead(raw, path, []);
    return head && this.placeFields(head.o, head.at, path);
  }

  /** The object and its `at`, after refusing keys that are unknown or not used by that `at`. */
  private placeHead(
    raw: unknown,
    path: string,
    extra: readonly string[],
  ): { readonly o: Obj; readonly at: InboxPlaceAt } | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isObj(raw)) return this.fail(path, "must be an object");
    const at = this.choice(raw.at, INBOX_PLACES, join(path, "at"), true);
    const takes: readonly string[] =
      at === undefined ? [] : INBOX_PLACE_FIELDS[at];
    for (const key of Object.keys(raw)) {
      if (key === "at" || extra.includes(key) || takes.includes(key)) continue;
      const known = INBOX_PLACE_FIELD_ORDER.some((field) => field === key);
      if (known && at === undefined) continue;
      this.fail(
        join(path, key),
        known
          ? `is not used by at "${at}"; it takes: ${list(takes)}`
          : `is not a field here; use: at, ${list([...(at === undefined ? INBOX_PLACE_FIELD_ORDER : takes), ...extra])}`,
      );
    }
    return at === undefined ? undefined : { o: raw, at };
  }

  private placeFields(
    o: Obj,
    at: InboxPlaceAt,
    path: string,
  ): InboxPlace | undefined {
    const field = (key: string) => join(path, key);
    const machine = this.machine(o.machine, field("machine"));
    const agentId = this.agentId(o.agentId, field("agentId"));
    const cloudAgentId = this.cloudAgentId(
      o.cloudAgentId,
      field("cloudAgentId"),
    );
    const where = this.placePath(o.path, field("path"), at);
    const url = this.httpsUrl(o.url, field("url"));
    const branch = this.branch(o.branch, field("branch"));
    const commit = this.commit(o.commit, field("commit"));
    const pr = this.httpsUrl(o.pr, field("pr"));
    const place: InboxPlace = {
      at,
      ...opt("machine", machine),
      ...opt("agentId", agentId),
      ...opt("cloudAgentId", cloudAgentId),
      ...opt("path", where),
      ...opt("url", url),
      ...opt("branch", branch),
      ...opt("commit", commit),
      ...opt("pr", pr),
    };
    const locators = INBOX_PLACE_LOCATORS[at];
    if (
      !locators.some((field) => place[field] !== undefined) &&
      !this.errors.some((e) => e.path.startsWith(path))
    )
      this.fail(path, `at "${at}" needs ${locators.join(" or ")}`);
    return place;
  }

  private machine(raw: unknown, path: string): InboxMachine | undefined {
    const o = this.object(raw, path, ["id", "label"]);
    const id = this.text(o?.id, join(path, "id"), INBOX_LIMITS.machineField, {
      required: o !== undefined,
      oneLine: true,
    });
    const label = this.text(
      o?.label,
      join(path, "label"),
      INBOX_LIMITS.machineField,
      { required: o !== undefined, oneLine: true },
    );
    return id === undefined || label === undefined ? undefined : { id, label };
  }

  private agentId(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, 64, { oneLine: true });
    if (text === undefined) return undefined;
    return (
      normalizeAgentId(text) ??
      this.fail(path, "must be a full agentId (8-4-4-4-12 hex)")
    );
  }

  private cloudAgentId(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, 100, { oneLine: true });
    if (text === undefined) return undefined;
    return CLOUD_AGENT_ID.test(text)
      ? text
      : this.fail(path, "must look like bc-… (letters, digits, - and _)");
  }

  private placePath(
    raw: unknown,
    path: string,
    at: InboxPlaceAt,
  ): string | undefined {
    const text = this.text(raw, path, INBOX_LIMITS.path, { oneLine: true });
    if (text === undefined) return undefined;
    if (at === "owner-computer")
      return text.startsWith("/") || WINDOWS_ABSOLUTE.test(text)
        ? text
        : this.fail(path, "must be an absolute path");
    const parts = text.split("/");
    const under = (root: string) =>
      text === root || text.startsWith(`${root}/`);
    return (under("/workspace") || under("/home")) && !parts.includes("..")
      ? text
      : this.fail(path, "must be an absolute path under /workspace or /home");
  }

  private branch(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, INBOX_LIMITS.branch, { oneLine: true });
    if (text === undefined) return undefined;
    return /\s/.test(text) ? this.fail(path, "must not contain spaces") : text;
  }

  private commit(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, 64, { oneLine: true });
    if (text === undefined) return undefined;
    return COMMIT.test(text)
      ? text
      : this.fail(path, "must be a commit SHA (7 to 64 hex characters)");
  }

  private link(raw: unknown, path: string): InboxLink | undefined {
    const o = this.object(raw, path, ["label", "url"]);
    if (o === undefined)
      return this.fail(path, "must be an object with label and url");
    const label = this.text(
      o.label,
      join(path, "label"),
      INBOX_LIMITS.refLabel,
      {
        required: true,
        oneLine: true,
      },
    );
    const url = this.httpsUrl(o.url, join(path, "url"));
    if (o.url === undefined || o.url === null)
      this.fail(join(path, "url"), "is required");
    return label === undefined || url === undefined
      ? undefined
      : { label, url };
  }

  private replyTo(raw: unknown): { readonly agentId: string } | undefined {
    const o = this.object(raw, "replyTo", ["agentId"]);
    if (o === undefined) return undefined;
    if (o.agentId === undefined || o.agentId === null)
      return this.fail("replyTo.agentId", "is required");
    const agentId = this.agentId(o.agentId, "replyTo.agentId");
    return agentId === undefined ? undefined : { agentId };
  }

  private to(
    raw: unknown,
  ): { readonly session?: string; readonly job?: string } | undefined {
    const o = this.object(raw, "to", ["session", "job"]);
    if (o === undefined) {
      if (isObj(raw) && Object.keys(raw).length === 0)
        this.fail("to", NEEDS_SESSION_OR_JOB);
      return undefined;
    }
    const hasSession = o.session !== undefined && o.session !== null;
    const hasJob = o.job !== undefined && o.job !== null;
    if (!hasSession && !hasJob) {
      if ("session" in o) this.fail("to.session", "is required");
      if ("job" in o) this.fail("to.job", "is required");
      if (!("session" in o) && !("job" in o))
        this.fail("to", NEEDS_SESSION_OR_JOB);
      return undefined;
    }
    const session = hasSession ? this.sessionAddress(o.session) : undefined;
    const job = hasJob ? this.jobRef(o.job) : undefined;
    if ((hasSession && session === undefined) || (hasJob && job === undefined))
      return undefined;
    return { ...opt("session", session), ...opt("job", job) };
  }

  private sessionAddress(raw: unknown): string | undefined {
    const session = this.text(raw, "to.session", SESSION_ADDRESS_MAX_LENGTH, {
      oneLine: true,
    });
    if (session === undefined) return undefined;
    return parseSessionAddress(session) === undefined
      ? this.fail(
          "to.session",
          "must be a session address like omp:<id>, copied exactly from the Session in a message header",
        )
      : session;
  }

  /** The Job of a message header, lower-cased so it compares with a job id. */
  private jobRef(raw: unknown): string | undefined {
    const job = this.text(raw, "to.job", INBOX_JOB_MAX_LENGTH, {
      oneLine: true,
    });
    if (job === undefined) return undefined;
    return JOB_REF.test(job)
      ? job.toLowerCase()
      : this.fail(
          "to.job",
          "must be the Job from a message header: 8 to 36 hex characters or dashes, copied exactly",
        );
  }

  private itemId(raw: unknown, path: string): string | undefined {
    const text = this.text(raw, path, 16, { required: true, oneLine: true });
    if (text === undefined) return undefined;
    return ITEM_ID.test(text)
      ? text
      : this.fail(path, "must be an item id (8 lowercase letters or digits)");
  }

  private dedupeKey(raw: unknown): string | undefined {
    const text = this.text(raw, "dedupeKey", INBOX_LIMITS.dedupeKey, {
      oneLine: true,
    });
    if (text === undefined) return undefined;
    return DEDUPE_KEY.test(text)
      ? text
      : this.fail("dedupeKey", "may only use a-z, 0-9, . _ and -");
  }
}

/**
 * Checks a draft (the item fields a poster writes) and returns it clean: strings trimmed,
 * empty values dropped, severity defaulted, keys in file order. Every problem is reported
 * with the path of its field; text that looks like a credential is refused by name.
 */
export function validateInboxDraft(draft: unknown): InboxValidation {
  const reader = new Reader();
  const item = reader.draft(draft);
  if (reader.errors.length > 0 || item === undefined)
    return { ok: false, errors: reader.errors };
  return { ok: true, item };
}

/** Checks one free-text value (an update note, a close reason) like a draft's text. */
export function validateInboxText(
  raw: unknown,
  path: string,
  max: number,
  flags: { readonly required?: boolean; readonly oneLine?: boolean } = {},
): { readonly value?: string; readonly errors: readonly InboxIssue[] } {
  const reader = new Reader();
  const value = reader.text(raw, path, max, flags);
  return { ...opt("value", value), errors: reader.errors };
}

/** Checks an https URL (a close reference). */
export function validateInboxUrl(
  raw: unknown,
  path: string,
): { readonly value?: string; readonly errors: readonly InboxIssue[] } {
  const reader = new Reader();
  const value = reader.httpsUrl(raw, path);
  return { ...opt("value", value), errors: reader.errors };
}
