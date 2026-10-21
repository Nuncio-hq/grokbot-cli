import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boxStore } from "../box-store.js";
import { createCommandRunner } from "../command-runner.js";
import type { CommandRunner } from "../command-runner-contract.js";
import type { JsonObject } from "../contracts.js";
import {
  INBOX_ROOT,
  type InboxItem,
  inboxFileName,
  inboxSlug,
} from "../inbox-schema.js";
import { type InboxStateStore, inboxStateStore } from "../inbox-state-store.js";
import { type JobStore, jobStore } from "../job-store.js";
import type { ProjectRoutes } from "../project-routes-store.js";
import type { ClientLabel } from "../usage-client.js";
import { type FakeBox, fakeBox } from "./fake-box.js";
import { fakeServer, type RecordedCall } from "./fake-server.js";
import { textReplyRow, userRow, type WireEntry } from "./wire-entries.js";

export const BOT = "f882ec52-17b1-4639-b0fc-07fed7526b09";
export const OTHER_BOT = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";
/** The run that left every item built by `inboxItem`. */
export const RUN = "run-left-the-item";
/** The row of BOT's chat that carries RUN: the one a reply answers. */
export const RUN_ROW = "entry-150";
export const NOW = Date.parse("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;

const AGENTS = {
  agents: [
    {
      id: "1",
      agentId: BOT,
      name: "Primary Test",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
    },
    {
      id: "2",
      agentId: OTHER_BOT,
      name: "Staff Test",
      kind: "GROK_BOT_AGENT_KIND_AGENT",
    },
  ],
};

/** A complete, valid item created `hoursAgo` before NOW. */
export function inboxItem(
  id: string,
  overrides: Partial<InboxItem> & { readonly hoursAgo?: number } = {},
): InboxItem {
  const { hoursAgo = 1, ...rest } = overrides;
  const created = new Date(NOW - hoursAgo * HOUR).toISOString().slice(0, 19);
  return {
    schema: "grokbot.inbox.item/v1",
    id,
    project: "Acme Web",
    kind: "bug",
    severity: "normal",
    title: `Item ${id}`,
    ask: { doneWhen: "the page loads" },
    from: { agentId: BOT, run: RUN, cwd: "/workspace/acme" },
    createdAt: `${created}Z`,
    updatedAt: `${created}Z`,
    expiresAt: `${new Date(NOW + 48 * HOUR).toISOString().slice(0, 19)}Z`,
    status: "open",
    ...rest,
  };
}

/** The cloud path of an item's file. */
export function itemPath(
  item: Pick<InboxItem, "project" | "createdAt" | "kind" | "id">,
  folder: "open" | "closed" = "open",
): string {
  const file = inboxFileName(item.createdAt, item.kind, item.id);
  return `${INBOX_ROOT}/${inboxSlug(item.project)}/${folder}/${file}`;
}

export interface Sent {
  readonly agentId: string;
  readonly text: string;
  readonly replyToId: string | undefined;
}

export interface InboxWorld {
  readonly runner: CommandRunner;
  /** Cloud files by absolute path; the manifest follows them. */
  readonly files: Record<string, string>;
  /** Raise the manifest's etag after changing `files`, like the server's sync does. */
  sync(): void;
  readonly box: FakeBox;
  readonly log: readonly RecordedCall[];
  readonly sent: readonly Sent[];
  /** The saved jobs, as the runner sees them. */
  readonly jobs: JobStore;
  /** What the runner takes for now; move `ms` to let time pass. Starts at NOW. */
  readonly clock: { ms: number };
  /** A temp folder per world; `project` is a folder with a path route labelled "Acme Web". */
  readonly dir: string;
  readonly project: string;
  readonly home: string;
  close(): Promise<void>;
}

export interface WorldOptions {
  readonly items?: readonly InboxItem[];
  /** Folder of a closed item, by item. */
  readonly closed?: readonly InboxItem[];
  readonly hostname?: string;
  /** Run the command as if from this folder instead of `project`. */
  readonly cwd?: "project" | "elsewhere";
  readonly routes?: boolean;
  /** Who is calling, as the host detected it; none by default (no runtime in messages). */
  readonly caller?: ClientLabel;
  /** The environment the runner reads the caller's session from; empty by default. */
  readonly env?: Readonly<Record<string, string>>;
  /** How often `inbox wait` looks at the store; default: the runner's. */
  readonly inboxPollMs?: number;
  /** The longest `inbox wait` the host allows, in seconds; default: no cap. */
  readonly maxInboxWaitSeconds?: number;
  /** The runner's state file store, built over the world's home; default: the real one. */
  readonly inboxState?: (home: string) => InboxStateStore;
}

/**
 * A runner over fakes only: a fake box store holding the items, two fake bots with a
 * transcript row of the run that left them, and a temp home for every file grokbot writes.
 */
export async function inboxWorld(
  options: WorldOptions = {},
): Promise<InboxWorld> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "grokbot-inbox-")));
  const project = join(dir, "acme");
  const elsewhere = join(dir, "elsewhere");
  await mkdir(project, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const files: Record<string, string> = {};
  for (const item of options.items ?? []) {
    files[itemPath(item)] = JSON.stringify(item, null, 2);
  }
  for (const item of options.closed ?? []) {
    files[itemPath(item, "closed")] = JSON.stringify(item, null, 2);
  }
  const box = fakeBox(files);
  // The fake box reads its own state; point it at the world's files.
  box.state.files = files;
  const rows = new Map<string, WireEntry[]>([
    [
      BOT,
      [
        textReplyRow(139, "older", "run-0"),
        textReplyRow(150, "I left an inbox item", RUN),
        // A row of the bot's chat that no run left, as one typed by hand.
        textReplyRow(155, "typed by hand", null),
        textReplyRow(160, "something later", "run-9"),
      ],
    ],
    [OTHER_BOT, [textReplyRow(139, "older", "run-0")]],
  ]);
  const sent: Sent[] = [];
  let seq = 200;
  const { server, log } = fakeServer({
    calls: {
      ...box.calls,
      ListGrokBotAgents: () => AGENTS,
      ListGrokBotUserComputers: () => ({
        computers: [
          {
            machineId: "machine-1",
            lastSeenAtMs: String(NOW - 5 * 60_000),
            hello: { label: "Example-Mac", kind: "desktop" },
          },
        ],
      }),
      ListGrokBotTranscriptEntries: (body: JsonObject) => {
        const all = rows.get(String(body.agentId)) ?? [];
        const before =
          typeof body.beforeSeq === "string"
            ? Number(body.beforeSeq)
            : Number.POSITIVE_INFINITY;
        const limit = typeof body.limit === "number" ? body.limit : 50;
        return {
          entries: all.filter((r) => Number(r.seq) < before).slice(-limit),
        };
      },
      ListGrokBotAgentStatuses: (body: JsonObject) => ({
        statuses: ((body.agentIds as string[] | undefined) ?? []).map(
          (agentId) => ({ agentId }),
        ),
      }),
      SendGrokBotUserMessage: (body: JsonObject) => {
        const agentId = String(body.agentId);
        sent.push({
          agentId,
          text: String(body.text),
          replyToId:
            typeof body.replyToId === "string" ? body.replyToId : undefined,
        });
        rows.get(agentId)?.push(
          userRow(++seq, String(body.text), {
            clientNonce: String(body.messageId),
            requestId: `run-${String(body.messageId)}`,
          }),
        );
        return { dispatched: true, delivery: "ACCEPTED_TEMPORAL" };
      },
    },
  });
  const routes: ProjectRoutes = new Map(
    options.routes === false
      ? []
      : [[project, { agentId: BOT, label: "Acme Web" }]],
  );
  const home = join(dir, "home");
  const cwd = options.cwd === "elsewhere" ? elsewhere : project;
  const jobs = jobStore(join(dir, "jobs"));
  const clock = { ms: NOW };
  const runner = createCommandRunner({
    server,
    jobs,
    boxStore: boxStore({
      server,
      fetch: box.fetch,
      cacheDir: join(dir, "cache"),
    }),
    inboxState: (options.inboxState ?? inboxStateStore)(home),
    hostname: options.hostname ?? "example-mac",
    now: () => clock.ms,
    projectRoutes: async () => routes,
    cwd,
    ...(options.caller !== undefined && { caller: options.caller }),
    env: options.env ?? {},
    home,
    ...(options.inboxPollMs !== undefined && {
      inboxPollMs: options.inboxPollMs,
    }),
    ...(options.maxInboxWaitSeconds !== undefined && {
      maxInboxWaitSeconds: options.maxInboxWaitSeconds,
    }),
  });
  return {
    runner,
    files,
    sync: () => {
      box.state.etag = `etag-${Object.keys(files).length}-${Date.now()}`;
    },
    box,
    log,
    sent,
    jobs,
    clock,
    dir,
    project,
    home,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Writes a file, creating its folders. */
export async function writeFileAt(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
