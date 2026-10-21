import { setTimeout as delay } from "node:timers/promises";
import type { Agent } from "./agents.js";
import type {
  DeliveredItem,
  InboxNotice,
  InboxOutputs,
} from "./command-outputs-inbox.js";
import type { RunnerContext } from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import {
  inboxRefs,
  isExpired,
  readInboxItems,
  toJobOf,
  toSessionOf,
} from "./inbox-reader.js";
import type { InboxItem } from "./inbox-types.js";
import type { JobStore } from "./job-store.js";
import { JOB_HANDLE_LENGTH } from "./next-step.js";

/** How often `inbox wait` looks at the store's manifest: one cheap Stat call each time. */
export const INBOX_POLL_MS = 20_000;
/** A catch-up notice looks at most this often. */
export const NOTICE_INTERVAL_MS = 60_000;
/** A catch-up notice never holds a command up longer than this. */
export const NOTICE_BUDGET_MS = 2_000;

const JOB_ID = /^[0-9a-f-]{8,36}$/;

/** The 8-character handle of a job id or of a handle copied from a header, or undefined. */
export function jobHandleOf(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  return JOB_ID.test(text) ? text.slice(0, JOB_HANDLE_LENGTH) : undefined;
}

/** What an agent's inbox commands look for: items for this session, or for one of these jobs. */
export interface Watch {
  readonly session?: string;
  /** Job handles, the first 8 characters of the job ids. */
  readonly jobs: ReadonlySet<string>;
}

/** The handles of the jobs the saved job records say `session` sent. An unreadable store has none. */
export async function sentJobs(
  jobs: JobStore,
  session: string | undefined,
): Promise<ReadonlySet<string>> {
  if (session === undefined) return new Set();
  const saved = await jobs.list().catch(() => []);
  return new Set(
    saved
      .filter((job) => job.session === session)
      .flatMap((job) => jobHandleOf(job.jobId) ?? []),
  );
}

/**
 * This caller's session, and the jobs to watch: the `--job` values when given, else every
 * job this session sent. Refuses a `--job` that is not a job id.
 */
export async function watchFor(
  ctx: RunnerContext,
  jobFlags: readonly string[] = [],
): Promise<Watch> {
  const session = await ctx.sessionAddress();
  const given = jobFlags.map((raw) => {
    const handle = jobHandleOf(raw);
    if (handle !== undefined) return handle;
    throw new GrokBotError(
      "ambiguous",
      `--job "${raw}" is not a job id: pass the id send or ask printed, or the 8 characters after Job: in a message header.`,
    );
  });
  return {
    ...(session !== undefined && { session }),
    jobs: given.length > 0 ? new Set(given) : await sentJobs(ctx.jobs, session),
  };
}

export const hasTargets = (watch: Watch): boolean =>
  watch.session !== undefined || watch.jobs.size > 0;

/** The item is addressed to the watched session, or to one of the watched jobs. */
export function isForWatch(item: InboxItem, watch: Watch): boolean {
  const toSession = toSessionOf(item);
  if (toSession !== undefined && toSession === watch.session) return true;
  const toJob = toJobOf(item);
  return toJob !== undefined && watch.jobs.has(toJob);
}

const botOf = (agents: readonly Agent[], agentId: string) => {
  const name = agents.find((a) => a.agentId === agentId)?.name;
  return { agentId, ...(name !== undefined && { name }) };
};

function delivered(item: InboxItem, agents: readonly Agent[]): DeliveredItem {
  const toSession = toSessionOf(item);
  const toJob = toJobOf(item);
  const { doneWhen, reply, choices } = item.ask ?? {};
  return {
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    project: item.project,
    title: item.title,
    bot: botOf(agents, item.from.agentId),
    ...(toSession !== undefined && { toSession }),
    ...(toJob !== undefined && { toJob }),
    ...(typeof doneWhen === "string" && doneWhen !== "" && { doneWhen }),
    ...(typeof reply === "string" && reply !== "" && { reply }),
    ...(Array.isArray(choices) && choices.length > 0 && { choices }),
  };
}

/**
 * The open items for `watch` that nothing has handed to this computer's agents yet: not
 * delivered by an earlier wait, check or notice, not replied to or closed from here, not
 * expired. Critical first, then oldest first. Costs one Stat call when nothing changed.
 */
export async function findUndelivered(
  ctx: RunnerContext,
  watch: Watch,
  signal?: AbortSignal,
): Promise<readonly DeliveredItem[]> {
  const [handled, { delivered: seen }] = await Promise.all([
    ctx.inboxState.read(),
    ctx.inboxState.readDelivery(),
  ]);
  const snapshot = await ctx.boxStore.snapshot(signal);
  const candidates = inboxRefs(snapshot).filter(
    (ref) => ref.folder === "open" && !seen.has(ref.id) && !handled.has(ref.id),
  );
  if (candidates.length === 0) return [];
  const nowMs = ctx.now();
  const mine = (await readInboxItems(ctx.boxStore, candidates, signal))
    .flatMap((read) => (read.state === "ok" ? [read.item] : []))
    .filter((item) => !isExpired(item, nowMs) && isForWatch(item, watch))
    .sort(
      (a, b) =>
        Number(b.severity === "critical") - Number(a.severity === "critical") ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
  if (mine.length === 0) return [];
  // The bot's name is a nicety: a roster that cannot be read must not hide the items.
  const agents = await ctx.fetchAgents(signal).catch(() => []);
  return mine.map((item) => delivered(item, agents));
}

/** Seconds from `90`, `90s`, `9m` or `1h`; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d{1,7})\s*([smh]?)$/i.exec(text.trim());
  if (match === null) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  return Number(match[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
}

const NOTHING_TO_WATCH =
  "grokbot inbox wait has nothing to watch: grokbot cannot tell which agent session this is, and no job was sent from it. Pass --job <job>, the id send or ask printed or the 8 characters after Job: in the header of your message.";

export async function waitInbox(
  ctx: RunnerContext,
  input: { readonly job?: readonly string[]; readonly timeout: string },
  signal?: AbortSignal,
): Promise<InboxOutputs["inbox-wait"]> {
  const asked = parseDuration(input.timeout);
  if (asked === undefined) {
    throw new GrokBotError(
      "ambiguous",
      `--timeout "${input.timeout}" is not a duration: use seconds or a number with s, m or h, such as 90s, 9m or 1h.`,
    );
  }
  const seconds = Math.min(asked, ctx.maxInboxWaitSeconds ?? asked);
  const first = await watchFor(ctx, input.job);
  if (!hasTargets(first)) throw new GrokBotError("not-found", NOTHING_TO_WATCH);
  const started = Date.now();
  const deadline = started + seconds * 1000;
  for (;;) {
    // Looked up afresh: a job this session sends while it waits counts too.
    const watch =
      (input.job?.length ?? 0) > 0
        ? first
        : { ...first, jobs: await sentJobs(ctx.jobs, first.session) };
    const items = await findUndelivered(ctx, watch, signal);
    const left = deadline - Date.now();
    if (items.length > 0 || left <= 0) {
      if (items.length > 0) {
        await ctx.inboxState.markDelivered(
          items.map((item) => item.id),
          ctx.now(),
        );
      }
      return {
        items,
        timedOut: items.length === 0,
        waitedSeconds: Math.round((Date.now() - started) / 1000),
        watching: {
          ...(watch.session !== undefined && { session: watch.session }),
          jobs: [...watch.jobs].sort(),
        },
      };
    }
    await delay(Math.min(ctx.inboxPollMs, left), undefined, { signal });
  }
}

/** For a hook that runs before the agent stops: what is undelivered for this session or its jobs. */
export async function checkInbox(
  ctx: RunnerContext,
  signal?: AbortSignal,
): Promise<InboxOutputs["inbox-check"]> {
  const watch = await watchFor(ctx);
  if (!hasTargets(watch)) return { items: [] };
  const items = await findUndelivered(ctx, watch, signal);
  if (items.length > 0) {
    await ctx.inboxState.markDelivered(
      items.map((item) => item.id),
      ctx.now(),
    );
  }
  return { items };
}

/**
 * The catch-up notice for a command that has nothing to do with the inbox: undelivered open
 * items for this session or its jobs, looked up at most once a minute, and marked delivered
 * as they are shown. Time-boxed, and every failure (no sign-in, a broken state file, a
 * store that does not answer) is swallowed: a notice never fails or slows the command it
 * rides on.
 */
export async function inboxNotice(
  ctx: RunnerContext,
  signal?: AbortSignal,
): Promise<InboxNotice | undefined> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, NOTICE_BUDGET_MS);
  timer.unref();
  const attempt = async (): Promise<InboxNotice | undefined> => {
    const nowMs = ctx.now();
    const { noticeCheckedAtMs } = await ctx.inboxState.readDelivery();
    if (
      noticeCheckedAtMs !== undefined &&
      nowMs - noticeCheckedAtMs < NOTICE_INTERVAL_MS
    )
      return undefined;
    const watch = await watchFor(ctx);
    if (!hasTargets(watch)) return undefined;
    const items = await findUndelivered(ctx, watch, controller.signal);
    // Only a lookup that finished counts: a slow or failed one is retried by the next command.
    if (controller.signal.aborted) return undefined;
    await ctx.inboxState.markNoticeChecked(nowMs);
    if (items.length === 0) return undefined;
    await ctx.inboxState.markDelivered(
      items.map((item) => item.id),
      nowMs,
    );
    return { items };
  };
  const expired = new Promise<undefined>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve(undefined), {
      once: true,
    }),
  );
  try {
    return await Promise.race([attempt(), expired]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}
