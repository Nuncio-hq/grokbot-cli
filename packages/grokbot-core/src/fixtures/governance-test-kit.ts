import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, type CommandInput } from "../command-catalog.js";
import { governanceHandlers } from "../command-handlers-governance.js";
import { createCommandRunner } from "../command-runner.js";
import { createRunnerContext } from "../command-runner-context.js";
import type { CommandOutput, RunOptions } from "../command-runner-contract.js";
import { confirmedFor } from "../command-spec.js";
import type { GovernanceCommandName } from "../command-specs-governance.js";
import type {
  GatewayTransport,
  JsonObject,
  ServerTransport,
} from "../contracts.js";
import type { GovernanceDeps, WorkerChild } from "../governance-deps.js";
import { jobStore } from "../job-store.js";
import {
  assertGatewayMethodAllowed,
  assertMethodAllowed,
} from "../method-safety.js";

export const PRIMARY = "f882ec52-17b1-4639-b0fc-07fed7526b09";
export const STAFF = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";
const ROOM = "5ca1ab1e-0000-4000-8000-000000000001";
const KIND = "GROK_BOT_AGENT_KIND_AGENT";
export const ROSTER = {
  agents: [
    { id: "1", agentId: PRIMARY, name: "Primary Test", kind: KIND },
    { id: "2", agentId: STAFF, name: "Staff Test", kind: KIND },
    {
      id: "3",
      agentId: ROOM,
      name: "GB Test Room",
      kind: "GROK_BOT_AGENT_KIND_ROOM",
      memberAgentIds: [PRIMARY],
    },
  ],
};

interface Recorded {
  readonly via: "server" | "gateway";
  readonly method: string;
  readonly body: JsonObject;
  readonly confirmed: boolean;
}

/** Per method: a function of the body, or replies in order (the last repeats). */
export type Script = Readonly<
  Record<string, ((body: JsonObject) => unknown) | readonly unknown[]>
>;

/** Fake transports that log every call and enforce the live safety gate. */
function gatedTransports(server: Script, gateway: Script) {
  const log: Recorded[] = [];
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
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  const serverScript = { ListGrokBotAgents: [ROSTER], ...server };
  const serverT: ServerTransport = {
    async call(method, body, options = {}) {
      const confirmed = options.confirmed === true;
      assertMethodAllowed(method, confirmed);
      return reply("server", serverScript, method, body, confirmed);
    },
    stream(method) {
      throw new Error(`fake server: no stream ${method} in governance tests`);
    },
  };
  const gatewayT: GatewayTransport = {
    async call(method, body, options = {}) {
      const confirmed = options.confirmed === true;
      assertGatewayMethodAllowed(method, confirmed);
      return reply("gateway", gateway, method, body, confirmed);
    },
  };
  return { server: serverT, gateway: gatewayT, log };
}

const jobs = jobStore(join(tmpdir(), "grokbot-governance-never-written"));

/**
 * The real `createCommandRunner` over gated fakes. Its governance side effects are the real
 * ones (this Mac's approvals file, a real cursor-agent), so use it only on paths that never
 * reach them: refusals, card resolves without a local approval, and Box MCP calls.
 */
export function realGovernanceRunner(
  server: Script = {},
  gateway: Script = {},
) {
  const t = gatedTransports(server, gateway);
  const runner = createCommandRunner({
    server: t.server,
    gateway: t.gateway,
    jobs,
  });
  return { runner, log: t.log };
}

/** A spawned worker that runs until it is killed, then exits by signal. */
export function workerUntilKilled(
  events: string[],
): GovernanceDeps["spawnWorker"] {
  return (): WorkerChild => {
    let exit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    events.push("spawn");
    return {
      exited,
      kill: (signal) => {
        events.push(`kill ${signal}`);
        exit(null);
      },
    };
  };
}

/** Records every side effect a governance handler performs, with no real I/O. */
function fakeDeps(
  overrides: Partial<GovernanceDeps> = {},
  events: string[] = [],
) {
  const deps: GovernanceDeps = {
    approvals: {
      path: "/fake/.grokbot/local-tool-approvals.json",
      readActiveAccountScope: async () => "scope",
    },
    openUrl: async () => {
      events.push("open-url");
    },
    parentEnv: {
      HOME: "/Users/owner",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
      SECRET_KEY: "x",
    },
    makeRunDir: async () => {
      events.push("make-run-dir");
      return "/tmp/grokbot-worker-run";
    },
    removeDir: (dir) => {
      events.push(`remove ${dir}`);
    },
    makeFifo: async (path) => {
      events.push(`mkfifo ${path}`);
    },
    serveToken: (path) => {
      events.push(`serve ${path}`);
      return { stop: () => events.push("serve-stop"), serves: 2 };
    },
    spawnWorker: (command, env) => {
      events.push(
        `spawn ${command.join(" ")} | ${Object.keys(env).sort().join(",")}`,
      );
      return { exited: Promise.resolve(0), kill: () => undefined };
    },
    onTerminate: () => {
      events.push("trap");
      return () => events.push("untrap");
    },
    listRunDirs: async () => [],
    isAlive: () => false,
    uid: 501,
    ...overrides,
  };
  return { deps, events };
}

/**
 * Governance commands run the way `createCommandRunner` runs them (the real `confirmedFor`
 * gate on the catalog spec, then the handler) over gated fakes and injected side effects.
 */
export function governanceRunner(
  server: Script = {},
  gateway: Script = {},
  overrides: Partial<GovernanceDeps> = {},
  events: string[] = [],
) {
  const t = gatedTransports(server, gateway);
  const ctx = createRunnerContext({
    server: t.server,
    gateway: t.gateway,
    jobs,
  });
  const { deps } = fakeDeps(overrides, events);
  const handlers = governanceHandlers(ctx, {
    deps,
    cliPath: "/opt/cursor-agent",
  });
  const run = async <N extends GovernanceCommandName>(
    name: N,
    input: CommandInput<N>,
    options: RunOptions = {},
  ): Promise<CommandOutput<N>> =>
    handlers[name](input, {
      ...options,
      confirmed: confirmedFor(name, COMMANDS[name].safety, input),
    });
  return { run, log: t.log, events };
}
