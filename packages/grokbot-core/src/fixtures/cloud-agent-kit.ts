import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, type CommandInput } from "../command-catalog.js";
import { governanceHandlers } from "../command-handlers-governance.js";
import { createRunnerContext } from "../command-runner-context.js";
import type { CommandOutput, RunOptions } from "../command-runner-contract.js";
import { confirmedFor } from "../command-spec.js";
import type { GovernanceCommandName } from "../command-specs-governance.js";
import type { JsonObject, ServerTransport } from "../contracts.js";
import type { Sleep } from "../governance-cloud-agent-handlers.js";
import { jobStore } from "../job-store.js";
import {
  assertBackgroundComposerMethodAllowed,
  assertMethodAllowed,
} from "../method-safety.js";
import { PRIMARY, ROSTER, type Script } from "./governance-test-kit.js";

export { PRIMARY, STAFF } from "./governance-test-kit.js";

/** A connection of the update stream goes silent: it yields nothing more until it is closed. */
export const SILENT = Symbol("silent");

/**
 * One step of a scripted connection: a frame to yield, an Error to fail the stream with,
 * SILENT, or a function that moves the fake clock and returns the frame to yield.
 */
type Step = unknown;

/** What a function step may do to the fake clock. */
interface FakeTime {
  advance(ms: number): void;
}

/** A step that moves the fake clock forward by `ms` and then yields `frame`. */
export const after =
  (ms: number, frame: unknown) =>
  (time: FakeTime): unknown => {
    time.advance(ms);
    return frame;
  };

// The repo's TypeScript lib has no Promise.withResolvers, so the executor form it is.
const closed = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

interface CloudAgentWorld {
  /** The frames StreamBackgroundComposerUpdates yields on its one connection, in order. */
  readonly frames?: readonly Step[];
  /** Frames per connection, in the order they open; the stream ends at once past the last. */
  readonly connections?: readonly (readonly Step[])[];
  /** BackgroundComposerService unary replies: a function of the body, or replies in order. */
  readonly composer?: Script;
  /** GrokBotService replies besides the roster. */
  readonly server?: Script;
  /** Default: a fake clock that moves only when the command sleeps. */
  readonly sleep?: Sleep;
}

interface Recorded {
  readonly via: "server" | "composer";
  readonly method: string;
  readonly body: JsonObject;
  readonly confirmed: boolean;
}

const jobs = jobStore(join(tmpdir(), "grokbot-cloud-agents-never-written"));

/**
 * The governance cloud agent commands over fake transports that enforce the same safety
 * gates as the real ones, and a fake clock: sleeping advances it and records the pause.
 */
export function cloudAgentRunner(world: CloudAgentWorld = {}) {
  const log: Recorded[] = [];
  const events: string[] = [];
  const sleeps: number[] = [];
  const clock = { ms: 1_000_000 };
  // Each call of the stream takes the next connection; once they run out it ends at once.
  const connections = world.connections ?? [world.frames ?? []];
  let opened = 0;
  const queues = new Map<string, unknown[]>();

  const reply = (
    via: Recorded["via"],
    script: Script,
    method: string,
    body: JsonObject,
    confirmed: boolean,
  ): unknown => {
    log.push({ via, method, body, confirmed });
    const scripted = script[method];
    if (typeof scripted === "function") return scripted(body);
    if (!scripted) throw new Error(`fake ${via}: unscripted call ${method}`);
    const key = `${via}:${method}`;
    const queue = queues.get(key) ?? [...scripted];
    queues.set(key, queue);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };

  const serverScript: Script = { ListGrokBotAgents: [ROSTER], ...world.server };
  const server: ServerTransport = {
    async call(method, body, options = {}) {
      const confirmed = options.confirmed === true;
      assertMethodAllowed(method, confirmed);
      return reply("server", serverScript, method, body, confirmed);
    },
    stream(method) {
      throw new Error(`fake server: no stream ${method} in cloud agent tests`);
    },
  };
  const composer: ServerTransport = {
    async call(method, body, options = {}) {
      const confirmed = options.confirmed === true;
      assertBackgroundComposerMethodAllowed(method, confirmed);
      return reply("composer", world.composer ?? {}, method, body, confirmed);
    },
    stream(method, body, options = {}) {
      const confirmed = options.confirmed === true;
      assertBackgroundComposerMethodAllowed(method, confirmed);
      log.push({ via: "composer", method, body, confirmed });
      const script = connections[opened++] ?? [];
      // Like the real transport: an aborted caller signal ends the stream without frames.
      async function* frames() {
        events.push("stream open");
        try {
          for (const [i, step] of script.entries()) {
            if (options.signal?.aborted) return;
            if (step === SILENT) {
              await closed(options.signal);
              return;
            }
            events.push(`frame ${i + 1}`);
            if (step instanceof Error) throw step;
            yield typeof step === "function"
              ? (step as (time: FakeTime) => unknown)({
                  advance: (ms) => {
                    clock.ms += ms;
                  },
                })
              : step;
          }
        } finally {
          events.push("stream closed");
        }
      }
      return frames();
    },
  };

  const ctx = createRunnerContext({
    server,
    composer,
    jobs,
    now: () => clock.ms,
  });
  // Yields a macrotask first, so a frame the fake stream has ready always beats an idle
  // watchdog the command arms beside it; a watchdog that is aborted advances nothing.
  const sleep: Sleep =
    world.sleep ??
    (async (ms, signal) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      sleeps.push(ms);
      clock.ms += ms;
    });
  const handlers = governanceHandlers(ctx, { sleep });
  const run = async <N extends GovernanceCommandName>(
    name: N,
    input: CommandInput<N>,
    options: RunOptions = {},
  ): Promise<CommandOutput<N>> =>
    handlers[name](input, {
      ...options,
      confirmed: confirmedFor(name, COMMANDS[name].safety, input),
    });
  return { run, log, events, sleeps };
}

/** The usual `cloud-agents` input; override what a test varies. */
export const listInput = (
  overrides: Partial<CommandInput<"cloud-agents">> = {},
): CommandInput<"cloud-agents"> => ({ limit: 20, json: false, ...overrides });

/** The usual `cloud-agent` input; override what a test varies. */
export const showInput = (
  bcId: string,
  overrides: Partial<CommandInput<"cloud-agent">> = {},
): CommandInput<"cloud-agent"> => ({
  bcId,
  messages: 10,
  wait: false,
  timeout: 600,
  json: false,
  ...overrides,
});

export const BOT_ID = PRIMARY;

export const BC_A = "bc-00000000-0000-4000-8000-0000000000a1";
export const BC_B = "bc-00000000-0000-4000-8000-0000000000b2";
export const BC_C = "bc-00000000-0000-4000-8000-0000000000c3";
export const WORKFLOW = "CLOUD_AGENT_WORKFLOW_STATUS_";

/** A BackgroundComposer row as the server's JSON carries it (false and zero values left out). */
export const composerRow = (
  bcId: string,
  over: Record<string, unknown> = {},
) => ({
  bcId,
  name: `Agent ${bcId.slice(-2)}`,
  repoUrl: "https://example.test/acme/widgets",
  branchName: "cursor/work",
  updatedAtMs: 1_790_000_000_000,
  workflowStatus: `${WORKFLOW}IDLE`,
  ...over,
});

/** The snapshot frame of StreamBackgroundComposerUpdates. */
export const snapshotFrame = (
  composers: unknown[],
  list: Record<string, unknown> = {},
  resumeCursor = "c1",
) => ({
  snapshot: { list: { composers, ...list }, resumeCursor },
});

/** An update event frame; `over` is the BackgroundComposerUpdateEvent. */
export const eventFrame = (
  bcId: string,
  over: Record<string, unknown> = {},
  resumeCursor = "c2",
) => ({
  event: {
    event: {
      bcId,
      kind: "BACKGROUND_COMPOSER_UPDATE_KIND_STATUS_CHANGED",
      workflowStatus: `${WORKFLOW}RUNNING`,
      updatedAtMs: "1790000000500",
      ...over,
    },
    resumeCursor,
  },
});

export const heartbeatFrame = (resumeCursor = "c0") => ({
  heartbeat: { resumeCursor },
});

/** A GetBackgroundComposerInfo reply for BC_A. */
export const infoReply = (over: Record<string, unknown> = {}, outer = {}) => ({
  composer: {
    composer: composerRow(BC_A, {
      prStatus: "PR_STATUS_OPEN",
      prUrl: "https://example.test/acme/widgets/pull/7",
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
      modelDetails: { modelName: "example-model", maxMode: false },
      ...over,
    }),
    baseBranch: "main",
    ...outer,
  },
});
