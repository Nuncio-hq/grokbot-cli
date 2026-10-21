import type { Agent } from "./agents.js";
import type { InboxHandled } from "./inbox-state-store.js";
import type { InboxItem, InboxKind, InboxSeverity } from "./inbox-types.js";

/**
 * How one file of an inbox folder read:
 * `ok` an item this grokbot understands; `needs-newer-grokbot` its schema has another major
 * version; `unreadable` it is not a valid item; `pending` the cloud computer lists the file
 * but the store holds no content for it yet (the sync takes about a minute).
 */
export type InboxRowState =
  | "ok"
  | "needs-newer-grokbot"
  | "unreadable"
  | "pending";

/** One line of `grokbot inbox`. Fields after `state` are absent unless the item read `ok`. */
export interface InboxRow {
  readonly id: string;
  /** The project folder the item sits in. */
  readonly slug: string;
  readonly state: InboxRowState;
  /** From the file name when the item itself could not be read. */
  readonly kind: InboxKind | string;
  readonly createdAt: string;
  readonly ageSeconds: number;
  readonly project?: string;
  readonly severity?: InboxSeverity;
  readonly title?: string;
  readonly bot?: { readonly agentId: string; readonly name?: string };
  /** The item has an `ask.blocking`: someone waits on it. */
  readonly blocking: boolean;
  /** `work.next` is on an owner computer whose label is this computer's. */
  readonly yourTurnHere: boolean;
  /** The session address the item is for (`to.session`); absent when it names none. */
  readonly toSession?: string;
  /** The job the item answers (`to.job`, first 8 characters); absent when it names none. */
  readonly toJob?: string;
  /** `toSession` is this caller's own session, or `toJob` one of the jobs it sent: the item is for this session. */
  readonly forThisSession: boolean;
  /** Set under --include-handled, for items replied to or closed from this computer. */
  readonly handled?: InboxHandled;
}

/** What the card of an item shows beside it. Never part of the item. */
export interface InboxDisplay {
  readonly bot?: { readonly agentId: string; readonly name?: string };
  readonly ageSeconds: number;
  /** A project route's folder on this computer: by git remote, else by the project's name. */
  readonly localFolder?: string;
  readonly yourTurnHere: boolean;
  /** The session address the item is for (`to.session`); absent when it names none. */
  readonly toSession?: string;
  /** The job the item answers (`to.job`, first 8 characters); absent when it names none. */
  readonly toJob?: string;
  /** `toSession` is this caller's own session, or `toJob` one of the jobs it sent: the item is for this session. */
  readonly forThisSession: boolean;
  /** `work.next.machine`, with when `grokbot computers` last saw it. */
  readonly machine?: {
    readonly label: string;
    readonly isThisComputer: boolean;
    /** ISO UTC; absent when no registered computer matches. */
    readonly lastSeenAt?: string;
  };
  /** Past `expiresAt` and still in the open folder. */
  readonly expired: boolean;
  readonly handled?: InboxHandled;
}

export interface SentToBot {
  readonly id: string;
  readonly jobId: string;
  readonly agent: Agent;
  /** The bot's transcript row the message answers, when the item's run was found. */
  readonly replyToId?: string;
  /** The bot was busy: the message goes out when it is free. */
  readonly queued: boolean;
}

/**
 * One open item `inbox wait`, `inbox check` or a notice hands to an agent: enough to act
 * on it or to open it (`grokbot inbox-show <id>`).
 */
export interface DeliveredItem {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly project: string;
  readonly title: string;
  readonly bot?: { readonly agentId: string; readonly name?: string };
  readonly toSession?: string;
  readonly toJob?: string;
  /** `ask.doneWhen`, `ask.reply` and `ask.choices`, when the item has them. */
  readonly doneWhen?: string;
  readonly reply?: string;
  readonly choices?: readonly string[];
}

/** Items a command found that nothing had shown this agent yet; `inboxNotice` on any other command's output. */
export interface InboxNotice {
  readonly items: readonly DeliveredItem[];
}

export interface FetchedFile {
  /** Path below the output folder. */
  readonly name: string;
  /** Where it was saved on this computer. */
  readonly path: string;
  readonly cloudPath: string;
  readonly sizeBytes: number;
}

export interface InboxOutputs {
  readonly inbox: {
    readonly scope: {
      readonly kind: "project" | "all";
      /** The project asked for, or this folder's route label. */
      readonly project?: string;
      readonly source: "flag" | "route" | "all";
    };
    /** This computer's name as items refer to it. */
    readonly computer: string;
    readonly items: readonly InboxRow[];
    readonly hiddenHandled: number;
    readonly hiddenExpired: number;
    /** Open items of other projects the scope leaves out. */
    readonly elsewhere: number;
    /** Projects with open items, for an empty scoped list. */
    readonly projects: readonly string[];
  };
  readonly "inbox-show": {
    readonly id: string;
    readonly folder: "open" | "closed";
    /** Absent when the item's schema has another major version. */
    readonly item?: InboxItem;
    /** Set with a missing `item`: the schema the file declares. */
    readonly needsNewerGrokbot?: string;
    readonly display: InboxDisplay;
  };
  readonly "inbox-fetch": {
    readonly id: string;
    readonly out: string;
    readonly saved: readonly FetchedFile[];
  };
  readonly "inbox-reply": SentToBot & {
    readonly action: "reply" | "answer";
  };
  readonly "inbox-done": SentToBot & { readonly closedAs: string };
  readonly "inbox-wait": {
    /** Open items for this session or its jobs that nothing delivered before; empty on a timeout. */
    readonly items: readonly DeliveredItem[];
    readonly timedOut: boolean;
    readonly waitedSeconds: number;
    /** What was watched: this session (when known) and these jobs (first 8 characters). */
    readonly watching: {
      readonly session?: string;
      readonly jobs: readonly string[];
    };
  };
  readonly "inbox-check": {
    readonly items: readonly DeliveredItem[];
  };
}
