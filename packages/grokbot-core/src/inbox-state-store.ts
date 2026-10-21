import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GrokBotError } from "./contracts.js";

/** What this computer did with an inbox item. `answer` is a reply that chose one of a question's choices. */
export const INBOX_HANDLED_ACTIONS = ["reply", "answer", "done"] as const;
export type InboxHandledAction = (typeof INBOX_HANDLED_ACTIONS)[number];

export interface InboxHandled {
  /** ISO UTC time of the action. */
  readonly handledAt: string;
  readonly action: InboxHandledAction;
  /** Set for `done`: the outcome sent to the bot. */
  readonly outcome?: string;
  /** The job that carried the message to the bot. */
  readonly jobId: string;
}

/** item id → what this computer did with it. Empty until an item is replied to or closed. */
export type InboxState = ReadonlyMap<string, InboxHandled>;

/**
 * What this computer showed an agent without being asked for the item: item id → ISO UTC
 * time `inbox wait`, `inbox check` or a notice returned it. A delivered item is still
 * listed by `grokbot inbox`; it is only not returned by those three again.
 */
export interface InboxDelivery {
  readonly delivered: ReadonlyMap<string, string>;
  /** When a command last looked for undelivered items to put in a notice (epoch ms). */
  readonly noticeCheckedAtMs?: number;
}

/** Entries older than this are dropped on write: the cloud side deletes items long before. */
export const INBOX_STATE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export interface InboxStateStore {
  readonly path: string;
  /** What was replied to or closed from here. */
  read(): Promise<InboxState>;
  /** Writes `state` without entries older than 60 days (judged against `nowMs`); delivery stays as it is. */
  write(state: InboxState, nowMs?: number): Promise<void>;
  readDelivery(): Promise<InboxDelivery>;
  /** Records the items as delivered at `nowMs`, on top of what the file holds right now. */
  markDelivered(ids: readonly string[], nowMs: number): Promise<void>;
  /** Records that a notice check ran at `nowMs`. */
  markNoticeChecked(nowMs: number): Promise<void>;
}

const isHandledAction = (value: unknown): value is InboxHandledAction =>
  (INBOX_HANDLED_ACTIONS as readonly unknown[]).includes(value);

interface Disk {
  readonly handled: InboxState;
  readonly delivery: InboxDelivery;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `~/.grokbot/grokbot-cli-inbox-state.json`:
 * `{ "handled": { "<itemId>": { "handledAt": "<ISO>", "action": "reply|answer|done", "outcome"?: "<text>", "jobId": "<id>" } },
 *    "delivered": { "<itemId>": "<ISO>" }, "noticeCheckedAt"?: "<ISO>" }`.
 * `handled` hides items from `grokbot inbox` on this computer; `delivered` and
 * `noticeCheckedAt` keep `inbox wait`, `inbox check` and the catch-up notices from showing
 * an item twice. A file that cannot be read or parsed throws instead of reading as empty,
 * so a broken state never silently shows every handled item again as new work.
 */
export function inboxStateStore(home: string = homedir()): InboxStateStore {
  const path = join(home, ".grokbot", "grokbot-cli-inbox-state.json");
  const invalid = (detail: string) =>
    new GrokBotError(
      "safety",
      `${path}: ${detail} Fix or delete the file; items you handled here then show in grokbot inbox again.`,
    );
  const isoTime = (what: string, value: unknown): string => {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
      throw invalid(`${what} is not an ISO time.`);
    return value;
  };

  async function load(): Promise<Disk> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { handled: new Map(), delivery: { delivered: new Map() } };
      throw invalid("cannot be read.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("is not valid JSON.");
    }
    if (!isRecord(parsed))
      throw invalid(
        'must be an object with "handled", "delivered" and "noticeCheckedAt".',
      );
    const { handled: rawHandled = {}, delivered: rawDelivered = {} } = parsed;
    if (!isRecord(rawHandled))
      throw invalid(
        'its "handled" must be an object of "<itemId>": { "handledAt", "action", "jobId" }.',
      );
    if (!isRecord(rawDelivered))
      throw invalid(
        'its "delivered" must be an object of "<itemId>": <ISO time>.',
      );
    const handled = new Map<string, InboxHandled>();
    for (const [id, value] of Object.entries(rawHandled)) {
      if (!isRecord(value))
        throw invalid(`the entry for "${id}" must be an object.`);
      const { handledAt, action, outcome, jobId } = value;
      if (typeof handledAt !== "string" || Number.isNaN(Date.parse(handledAt)))
        throw invalid(`the handledAt of "${id}" is not an ISO time.`);
      if (!isHandledAction(action))
        throw invalid(
          `the action of "${id}" must be one of ${INBOX_HANDLED_ACTIONS.join(", ")}.`,
        );
      if (typeof jobId !== "string" || jobId === "")
        throw invalid(`the jobId of "${id}" must be a non-empty string.`);
      if (outcome !== undefined && typeof outcome !== "string")
        throw invalid(`the outcome of "${id}" must be a string.`);
      handled.set(id, {
        handledAt,
        action,
        jobId,
        ...(outcome !== undefined && { outcome }),
      });
    }
    const delivered = new Map<string, string>();
    for (const [id, value] of Object.entries(rawDelivered))
      delivered.set(id, isoTime(`the delivery time of "${id}"`, value));
    const checked =
      parsed.noticeCheckedAt === undefined
        ? undefined
        : Date.parse(isoTime("noticeCheckedAt", parsed.noticeCheckedAt));
    return {
      handled,
      delivery: {
        delivered,
        ...(checked !== undefined && { noticeCheckedAtMs: checked }),
      },
    };
  }

  async function save({ handled, delivery }: Disk, nowMs: number) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = (iso: string) =>
      Date.parse(iso) >= nowMs - INBOX_STATE_RETENTION_MS;
    const byId = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : 1);
    const keptHandled = [...handled]
      .filter(([, h]) => fresh(h.handledAt))
      .sort(byId);
    const keptDelivered = [...delivery.delivered]
      .filter(([, iso]) => fresh(iso))
      .sort(byId);
    const file = {
      handled: Object.fromEntries(keptHandled),
      delivered: Object.fromEntries(keptDelivered),
      ...(delivery.noticeCheckedAtMs !== undefined && {
        noticeCheckedAt: new Date(delivery.noticeCheckedAtMs).toISOString(),
      }),
    };
    // Write then rename, so a crash never leaves a half-written file behind.
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, path);
  }

  return {
    path,
    async read() {
      return (await load()).handled;
    },
    async write(state, nowMs = Date.now()) {
      const { delivery } = await load().catch(() => ({
        delivery: { delivered: new Map<string, string>() },
      }));
      await save({ handled: state, delivery }, nowMs);
    },
    async readDelivery() {
      return (await load()).delivery;
    },
    async markDelivered(ids, nowMs) {
      const { handled, delivery } = await load();
      const delivered = new Map(delivery.delivered);
      for (const id of ids) delivered.set(id, new Date(nowMs).toISOString());
      await save({ handled, delivery: { ...delivery, delivered } }, nowMs);
    },
    async markNoticeChecked(nowMs) {
      const { handled, delivery } = await load();
      await save(
        { handled, delivery: { ...delivery, noticeCheckedAtMs: nowMs } },
        nowMs,
      );
    },
  };
}
