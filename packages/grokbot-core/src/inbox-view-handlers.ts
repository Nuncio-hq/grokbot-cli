import type { Agent } from "./agents.js";
import type {
  InboxDisplay,
  InboxOutputs,
  InboxRow,
} from "./command-outputs-inbox.js";
import type { RunnerContext } from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import { listComputers } from "./governance-box-handlers.js";
import { isForWatch, sentJobs, type Watch } from "./inbox-delivery.js";
import {
  INBOX_ID,
  type InboxRef,
  inboxRefs,
  isExpired,
  isYourTurnHere,
  type ReadItem,
  readInboxItems,
  shortHost,
  toJobOf,
  toSessionOf,
} from "./inbox-reader.js";
import { inboxSlug } from "./inbox-schema.js";
import type { InboxItem } from "./inbox-types.js";
import { normalizeRemote, projectKeys } from "./project-routes.js";
import { isPathKey } from "./project-routes-store.js";

const ageOf = (iso: string, nowMs: number) =>
  Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000)) || 0;

const botOf = (agents: readonly Agent[], agentId: string) => {
  const name = agents.find((a) => a.agentId === agentId)?.name;
  return { agentId, ...(name !== undefined && { name }) };
};

const hasBlocking = (item: InboxItem) =>
  typeof item.ask?.blocking === "string" && item.ask.blocking !== "";

/** Critical first, then items for this session, then items someone waits on, then the oldest. */
function rank(row: InboxRow): number {
  if (row.severity === "critical") return 0;
  if (row.forThisSession) return 1;
  return row.blocking ? 2 : 3;
}

/**
 * What an item's `to` means for this caller: the session and job it names, and whether
 * it is this session's: its address, or a job this session sent.
 */
function sessionMarks(item: InboxItem, mine: Watch) {
  const toSession = toSessionOf(item);
  const toJob = toJobOf(item);
  return {
    ...(toSession !== undefined && { toSession }),
    ...(toJob !== undefined && { toJob }),
    forThisSession: isForWatch(item, mine),
  };
}

/** This caller: its session (when known) and the jobs it sent, as the reader marks items by. */
async function callerWatch(ctx: RunnerContext): Promise<Watch> {
  const session = await ctx.sessionAddress();
  return {
    ...(session !== undefined && { session }),
    jobs: await sentJobs(ctx.jobs, session),
  };
}

export async function listInbox(
  ctx: RunnerContext,
  input: {
    readonly project?: string;
    readonly all: boolean;
    readonly "include-handled": boolean;
  },
  signal?: AbortSignal,
): Promise<InboxOutputs["inbox"]> {
  if (input.project !== undefined && input.all) {
    throw new GrokBotError(
      "ambiguous",
      "--project and --all contradict each other: pass one of them.",
    );
  }
  const label = input.all
    ? undefined
    : (input.project ?? (await ctx.projectLabel()));
  const source = input.all
    ? "all"
    : input.project !== undefined
      ? "flag"
      : label !== undefined
        ? "route"
        : "all";
  const wanted = label === undefined ? undefined : inboxSlug(label);
  // A broken state file stops the list: it would show handled items as new work.
  const handled = await ctx.inboxState.read();
  const snapshot = await ctx.boxStore.snapshot(signal);
  const open = inboxRefs(snapshot).filter((ref) => ref.folder === "open");
  const inScope = open.filter(
    (ref) => wanted === undefined || ref.slug === wanted,
  );
  const outOfScope = open.filter((ref) => !inScope.includes(ref));
  const unhandled = (ref: InboxRef) =>
    input["include-handled"] || !handled.has(ref.id);
  const visible = inScope.filter(unhandled);
  const reads = await readInboxItems(ctx.boxStore, visible, signal);
  const nowMs = ctx.now();
  const mine = await callerWatch(ctx);
  const agents = reads.some((r) => r.state === "ok")
    ? await ctx.fetchAgents(signal)
    : [];
  let hiddenExpired = 0;
  const rows: InboxRow[] = [];
  for (const read of reads) {
    const { ref } = read;
    const record = handled.get(ref.id);
    const base = {
      id: ref.id,
      slug: ref.slug,
      kind: ref.kind,
      createdAt: ref.createdAt,
      ageSeconds: ageOf(ref.createdAt, nowMs),
      blocking: false,
      yourTurnHere: false,
      forThisSession: false,
      ...(record !== undefined && { handled: record }),
    };
    if (read.state !== "ok") {
      rows.push({ ...base, state: read.state });
      continue;
    }
    const { item } = read;
    if (isExpired(item, nowMs)) {
      hiddenExpired++;
      continue;
    }
    rows.push({
      ...base,
      state: "ok",
      kind: item.kind,
      createdAt: item.createdAt,
      ageSeconds: ageOf(item.createdAt, nowMs),
      project: item.project,
      severity: item.severity,
      title: item.title,
      bot: botOf(agents, item.from.agentId),
      blocking: hasBlocking(item),
      yourTurnHere: isYourTurnHere(item, ctx.hostname),
      ...sessionMarks(item, mine),
    });
  }
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
  return {
    scope: {
      kind: wanted === undefined ? "all" : "project",
      ...(label !== undefined && { project: label }),
      source,
    },
    computer: ctx.hostname,
    items: rows,
    hiddenHandled: input["include-handled"]
      ? 0
      : inScope.length - visible.length,
    hiddenExpired,
    elsewhere: outOfScope.filter(unhandled).length,
    projects: [
      ...new Set(outOfScope.filter(unhandled).map((r) => r.slug)),
    ].sort(),
  };
}

export interface FoundItem {
  readonly ref: InboxRef;
  readonly read: Exclude<ReadItem, { state: "pending" | "unreadable" }>;
}

/**
 * The one item with this id, open or closed. Refuses an id nothing carries, a file that
 * cannot be read, and one the store has not synced yet. An open item wins over a closed one.
 */
export async function findInboxItem(
  ctx: RunnerContext,
  rawId: string,
  signal?: AbortSignal,
): Promise<FoundItem> {
  const id = rawId.trim().toLowerCase();
  const unknown = new GrokBotError(
    "not-found",
    `No inbox item "${rawId}". grokbot inbox lists the open ones; ids are 8 letters and digits.`,
  );
  if (!INBOX_ID.test(id)) throw unknown;
  const snapshot = await ctx.boxStore.snapshot(signal);
  const matches = inboxRefs(snapshot)
    .filter((ref) => ref.id === id)
    .sort((a, b) => (a.folder === b.folder ? 0 : a.folder === "open" ? -1 : 1));
  const [ref, second] = matches;
  if (ref === undefined) throw unknown;
  if (second !== undefined && second.folder === ref.folder) {
    throw new GrokBotError(
      "ambiguous",
      `Two projects hold an inbox item with id ${id} (${ref.slug} and ${second.slug}). Ask the bots to close one.`,
    );
  }
  const [read] = await readInboxItems(ctx.boxStore, [ref], signal);
  if (read === undefined || read.state === "pending") {
    throw new GrokBotError(
      "not-found",
      `Inbox item ${id} is listed, but the store has no content for it yet. The cloud computer syncs about once a minute: try again shortly.`,
    );
  }
  if (read.state === "unreadable") {
    throw new GrokBotError(
      "protocol",
      `Inbox item ${id} (${ref.slug}/${ref.folder}) cannot be read: ${read.reason}.`,
    );
  }
  return { ref, read };
}

/** Folders of routes whose remote is one of `remotes` (first), else whose label is one of `labels`. */
async function routeFolder(
  ctx: RunnerContext,
  remotes: ReadonlySet<string>,
  labels: ReadonlySet<string>,
): Promise<string | undefined> {
  const routes = await ctx.projectRoutes();
  const folders = [...routes].filter(([key]) => isPathKey(key)).sort();
  const byRemote = await Promise.all(
    folders.map(async ([key]) => (await projectKeys(key)).remote),
  );
  const matched = folders.find((_, i) => {
    const remote = byRemote[i];
    return remote !== undefined && remotes.has(remote);
  });
  if (matched) return matched[0];
  return folders.find(
    ([, route]) =>
      route.label !== undefined && labels.has(inboxSlug(route.label)),
  )?.[0];
}

async function localFolder(
  ctx: RunnerContext,
  item: InboxItem,
): Promise<string | undefined> {
  const routes = await ctx.projectRoutes();
  const remotes = new Set(
    [item.from.git?.url, item.work?.latest?.url, item.work?.next?.url]
      .map((url) => (url === undefined ? undefined : normalizeRemote(url)))
      .filter((remote): remote is string => remote !== undefined),
  );
  const labels = new Set([inboxSlug(item.project)]);
  for (const remote of remotes) {
    const label = routes.get(remote)?.label;
    if (label !== undefined) labels.add(inboxSlug(label));
  }
  return routeFolder(ctx, remotes, labels);
}

export async function showInboxItem(
  ctx: RunnerContext,
  id: string,
  signal?: AbortSignal,
): Promise<InboxOutputs["inbox-show"]> {
  const { ref, read } = await findInboxItem(ctx, id, signal);
  const nowMs = ctx.now();
  const handled = (await ctx.inboxState.read()).get(ref.id);
  const handledField = handled !== undefined && { handled };
  if (read.state === "needs-newer-grokbot") {
    return {
      id: ref.id,
      folder: ref.folder,
      needsNewerGrokbot: read.schema,
      display: {
        ageSeconds: ageOf(ref.createdAt, nowMs),
        yourTurnHere: false,
        forThisSession: false,
        expired: false,
        ...handledField,
      },
    };
  }
  const { item } = read;
  const agents = await ctx.fetchAgents(signal);
  const machineRef = item.work?.next?.machine;
  let machine: InboxDisplay["machine"];
  if (machineRef !== undefined) {
    const { computers } = await listComputers(ctx, signal);
    const seen = computers.find(
      (c) =>
        (machineRef.id !== "" && c.machineId === machineRef.id) ||
        shortHost(c.label) === shortHost(machineRef.label),
    );
    machine = {
      label: machineRef.label,
      isThisComputer: shortHost(machineRef.label) === ctx.hostname,
      ...(seen !== undefined &&
        seen.lastSeenAtMs !== "0" && {
          lastSeenAt: new Date(Number(seen.lastSeenAtMs)).toISOString(),
        }),
    };
  }
  const folder = await localFolder(ctx, item);
  return {
    id: ref.id,
    folder: ref.folder,
    item,
    display: {
      bot: botOf(agents, item.from.agentId),
      ageSeconds: ageOf(item.createdAt, nowMs),
      ...(folder !== undefined && { localFolder: folder }),
      yourTurnHere: isYourTurnHere(item, ctx.hostname),
      ...sessionMarks(item, await callerWatch(ctx)),
      ...(machine !== undefined && { machine }),
      expired: isExpired(item, nowMs),
      ...handledField,
    },
  };
}
