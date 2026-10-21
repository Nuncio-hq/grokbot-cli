/**
 * The inbox item contract: what a GrokBot bot leaves on its cloud computer for the
 * assistants on the owner's computer. Types and constants only; `inbox-schema.ts`
 * re-exports everything here beside the helpers.
 */
export const INBOX_SCHEMA_ID = "grokbot.inbox.item/v1";

/** Where the inbox lives on the cloud computer. */
export const INBOX_ROOT = "/workspace/.grokbot/inbox";
/** Overrides the root, so tests and other layouts never touch the real one. */
export const INBOX_ROOT_ENV = "GROKBOT_INBOX_ROOT";

export const INBOX_KINDS = [
  "bug",
  "task",
  "question",
  "result",
  "decision",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_SEVERITIES = ["low", "normal", "high", "critical"] as const;
export type InboxSeverity = (typeof INBOX_SEVERITIES)[number];
export const INBOX_DEFAULT_SEVERITY: InboxSeverity = "normal";

export const INBOX_STATUSES = ["open", "closed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const INBOX_WORK_STATES = [
  "not-started",
  "in-progress",
  "blocked",
  "done",
] as const;
export type InboxWorkState = (typeof INBOX_WORK_STATES)[number];

/** Where a piece of work, or its next step, happens. */
export const INBOX_PLACES = [
  "owner-computer",
  "cloud-computer",
  "cloud-agent",
  "bot",
  "repo",
  "web",
] as const;
export type InboxPlaceAt = (typeof INBOX_PLACES)[number];

export const INBOX_NEXT_BY = ["session", "bot", "owner"] as const;
export type InboxNextBy = (typeof INBOX_NEXT_BY)[number];

/** What the next step waits on. */
export const INBOX_NEEDS = [
  "owner-computer-awake",
  "session",
  "owner-approval",
  "owner-payment",
  "owner-sign-in",
  "secret",
  "teammate-bot",
  "cloud-agent-finished",
  "review",
] as const;
export type InboxNeed = (typeof INBOX_NEEDS)[number];

export const INBOX_OUTCOMES = [
  "fixed",
  "answered",
  "done",
  "wont-fix",
  "duplicate",
  "superseded",
  "handed-off",
  "expired",
] as const;
export type InboxOutcome = (typeof INBOX_OUTCOMES)[number];

/** Days an item stays open without being closed, by kind. */
export const INBOX_EXPIRY_DAYS: Readonly<Record<InboxKind, number>> = {
  question: 2,
  result: 7,
  bug: 14,
  task: 14,
  decision: 14,
};

/** Closed items are deleted (with their files) this long after they were closed. */
export const INBOX_CLOSED_RETENTION_DAYS = 30;

/** The range of `--expires-in`: 1 hour to 30 days. */
export const INBOX_EXPIRES_IN = { minHours: 1, maxDays: 30 } as const;

/** Lengths in characters (code points) unless noted. */
export const INBOX_LIMITS = {
  project: 60,
  title: 100,
  text: 300,
  command: 500,
  summary: 4000,
  observed: 1000,
  expected: 1000,
  listItems: 20,
  listItem: 300,
  trail: 5,
  choicesMin: 2,
  choicesMax: 6,
  choice: 80,
  refs: 10,
  refLabel: 60,
  files: 10,
  /** Bytes, all files of one item together. */
  fileBytes: 10 * 1024 * 1024,
  relatesTo: 10,
  dedupeKey: 80,
  updates: 20,
  branch: 200,
  url: 2000,
  path: 1000,
  machineField: 100,
  cloudAgentId: 100,
} as const;

/** A job reference in a message header: the first 8 or more hex characters of a job id. */
export const INBOX_JOB_PATTERN = "^[0-9a-fA-F-]{8,36}$";
export const INBOX_JOB_MAX_LENGTH = 36;

export const INBOX_ID_LENGTH = 8;
/** The slug of an item whose project has no letters or digits. */
export const INBOX_GENERAL_SLUG = "_general";
export const INBOX_SLUG_LENGTH = 60;

export type InboxPlaceField =
  | "machine"
  | "agentId"
  | "cloudAgentId"
  | "path"
  | "url"
  | "branch"
  | "commit"
  | "pr";

/** Every field a place can carry, in file order. */
export const INBOX_PLACE_FIELD_ORDER: readonly InboxPlaceField[] = [
  "machine",
  "agentId",
  "cloudAgentId",
  "path",
  "url",
  "branch",
  "commit",
  "pr",
];

/** The fields each kind of place takes besides `at`. */
export const INBOX_PLACE_FIELDS: Readonly<
  Record<InboxPlaceAt, readonly InboxPlaceField[]>
> = {
  "owner-computer": ["machine", "path", "branch", "commit"],
  "cloud-computer": ["path", "branch", "commit"],
  "cloud-agent": ["cloudAgentId", "url", "branch", "commit", "pr"],
  bot: ["agentId"],
  repo: ["url", "branch", "commit", "pr"],
  web: ["url"],
};

/** A place needs at least one of these, so it says where it is. */
export const INBOX_PLACE_LOCATORS: Readonly<
  Record<InboxPlaceAt, readonly InboxPlaceField[]>
> = {
  "owner-computer": ["path", "machine"],
  "cloud-computer": ["path"],
  "cloud-agent": ["cloudAgentId", "url"],
  bot: ["agentId"],
  repo: ["url"],
  web: ["url"],
};

export interface InboxMachine {
  readonly id: string;
  readonly label: string;
}

export interface InboxPlace {
  readonly at: InboxPlaceAt;
  /** owner-computer only. */
  readonly machine?: InboxMachine;
  /** bot only. */
  readonly agentId?: string;
  /** cloud-agent only (`bc-…`). */
  readonly cloudAgentId?: string;
  /** owner-computer: absolute; cloud-computer: under /workspace or /home. */
  readonly path?: string;
  /** https; repo, web and cloud-agent. */
  readonly url?: string;
  readonly branch?: string;
  readonly commit?: string;
  /** https URL of a pull request. */
  readonly pr?: string;
}

export interface InboxTrailStep extends InboxPlace {
  readonly did: string;
  /** ISO UTC: when this step happened. */
  readonly asOf?: string;
}

export interface InboxNext extends InboxPlace {
  readonly by: InboxNextBy;
  readonly action?: string;
  readonly command?: string;
  readonly needs?: readonly InboxNeed[];
}

export interface InboxAsk {
  /** Required for a bug and a task. */
  readonly doneWhen?: string;
  readonly verify?: string;
  readonly reply?: string;
  /** Question only. */
  readonly choices?: readonly string[];
  readonly blocking?: string;
}

export interface InboxDetails {
  readonly summary?: string;
  readonly observed?: string;
  readonly expected?: string;
  readonly repro?: readonly string[];
  readonly alreadyChecked?: readonly string[];
  /** Bug only, ISO UTC. */
  readonly firstSeenAt?: string;
  /** Bug only, integer of at least 1. */
  readonly occurrences?: number;
}

export interface InboxWork {
  readonly state?: InboxWorkState;
  readonly trail?: readonly InboxTrailStep[];
  readonly latest?: InboxPlace;
  readonly next?: InboxNext;
}

export interface InboxLink {
  readonly label: string;
  readonly url: string;
}

export interface InboxFile {
  readonly name: string;
  /** `files/<id>/<name>`, relative to the project folder. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly sha256: string;
}

export interface InboxGit {
  /** https form of origin. */
  readonly url?: string;
  readonly branch?: string;
  readonly commit?: string;
}

export interface InboxFrom {
  /** The posting bot: CURSOR_CONVERSATION_ID. */
  readonly agentId: string;
  /** The posting run: CURSOR_REQUEST_ID. */
  readonly run: string;
  readonly cwd: string;
  readonly git?: InboxGit;
}

export interface InboxUpdate {
  readonly at: string;
  /** Absent when a person ran the command by hand. */
  readonly run?: string;
  readonly note: string;
}

export interface InboxClosed {
  readonly at: string;
  /** An agentId, or "grokbot" for an expiry or a command run by hand. */
  readonly by: string;
  readonly outcome: InboxOutcome;
  readonly reason?: string;
  readonly ref?: string;
}

/** What the poster writes: every item field except the ones grokbot stamps. */
export interface InboxDraft {
  readonly project: string;
  readonly kind: InboxKind;
  readonly severity: InboxSeverity;
  readonly title: string;
  readonly startHere?: string;
  readonly ask?: InboxAsk;
  readonly details?: InboxDetails;
  readonly work?: InboxWork;
  readonly refs?: readonly InboxLink[];
  readonly replyTo?: { readonly agentId: string };
  /**
   * Who the item is for: `session` is one assistant session's `<runtime>:<id>` address, `job`
   * one job that session sent (the Job from a message header, lower-case). At least one is set.
   */
  readonly to?: { readonly session?: string; readonly job?: string };
  readonly relatesTo?: readonly string[];
  readonly dedupeKey?: string;
}

/** One file of `<slug>/open/` or `<slug>/closed/`. */
export interface InboxItem extends InboxDraft {
  readonly schema: typeof INBOX_SCHEMA_ID;
  readonly id: string;
  readonly files?: readonly InboxFile[];
  readonly from: InboxFrom;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly updates?: readonly InboxUpdate[];
  readonly status: InboxStatus;
  readonly closed?: InboxClosed;
}

/** Fields only grokbot sets; a draft that carries one is refused. */
export const INBOX_STAMPED_FIELDS = [
  "schema",
  "id",
  "files",
  "from",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "updates",
  "status",
  "closed",
] as const;

/** The draft fields, in file order. */
export const INBOX_DRAFT_FIELDS = [
  "project",
  "kind",
  "severity",
  "title",
  "startHere",
  "ask",
  "details",
  "work",
  "refs",
  "replyTo",
  "to",
  "relatesTo",
  "dedupeKey",
] as const;
