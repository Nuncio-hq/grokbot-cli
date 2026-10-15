import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRunner } from "../command-runner.js";
import {
  type GatewayTransport,
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "../contracts.js";
import { jobStore } from "../job-store.js";
import {
  assertGatewayMethodAllowed,
  assertMethodAllowed,
} from "../method-safety.js";

export const MAIN = "9823898c-841c-4085-85bd-10d51e5e2a1d";
export const PRIMARY = "f882ec52-17b1-4639-b0fc-07fed7526b09";
export const STAFF = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";
export const PROBE = "5ca1ab1e-0000-4000-8000-0000000000aa";
export const ROOM = "5ca1ab1e-0000-4000-8000-0000000000bb";
export const PROBE_BRIEF =
  "Temporary bot\n\nWorkspace: your own folder is /workspace/staff/gb-phase2-probe/. " +
  "Keep your files there; put files other bots need in /workspace/shared/.";

export const wireBot = (
  agentId: string,
  name: string,
  fields: JsonObject = {},
) => ({
  id: "100",
  agentId,
  name,
  kind: "GROK_BOT_AGENT_KIND_AGENT",
  harness: "temporal",
  ...fields,
});

export const wireRoom = (
  agentId: string,
  name: string,
  memberAgentIds: readonly unknown[],
) => ({
  id: "200",
  agentId,
  name,
  kind: "GROK_BOT_AGENT_KIND_ROOM",
  harness: "temporal",
  memberAgentIds,
});

export const BASE_ROSTER = [
  wireBot(MAIN, "Grok Bot"),
  wireBot(PRIMARY, "Primary Test", { title: "Test bot" }),
  wireBot(STAFF, "Staff Test"),
];
export const PROBE_BOT = wireBot(PROBE, "GB Phase2 Probe", {
  title: "Probe",
  description: PROBE_BRIEF,
});

/** getAgentWorkflows rows as the live gateway sends them (body without frontmatter). */
export const PLUGIN_SKILL = {
  id: "plugin:docs",
  name: "docs",
  source: "plugin",
  description: "Docs",
  body: "Read the docs.",
};
export const MANAGED_SKILL = {
  id: "add-connector",
  name: "add-connector",
  source: "managed",
  description: "Connect an MCP server",
  body: "# Add a connector",
};
export const PUSHED_SKILL = {
  id: "gb-phase2-probe-skill",
  name: "gb-phase2-probe-skill",
  source: "workflow",
  description: "Probe",
  body: "Reply PROBE-OK.",
};
export const PUSHED_MARKDOWN =
  "---\nname: gb-phase2-probe-skill\ndescription: Probe\n---\n\nReply PROBE-OK.\n";
/** The four fields a skill output carries; the body stays on the gateway. */
export const listed = ({
  id,
  name,
  source,
  description,
}: typeof PUSHED_SKILL) => ({
  id,
  name,
  source,
  description,
});

export interface Recorded {
  readonly via: "server" | "gateway";
  readonly method: string;
  readonly body: JsonObject;
  readonly confirmed: boolean;
}

/** Per method: a function of the body, or replies in order (the last repeats). */
export type Script = Readonly<
  Record<string, ((body: JsonObject) => unknown) | readonly unknown[]>
>;

/** Replies in call order; a step that is an Error is thrown. The last step repeats. */
export function steps(...replies: readonly unknown[]) {
  let call = 0;
  return (): unknown => {
    const reply = replies[Math.min(call++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

export const httpError = (method: string, status: number, text = "") =>
  new GrokBotError(
    "http",
    `${method} failed with HTTP ${status}${text ? `: ${text}` : ""}`,
  );

/**
 * A command runner over fake server and gateway transports that log every call in one
 * ordered list and enforce the same safety gate as the real transports. Local state
 * (jobs, pending hires) lives under `stateDir`; pass one in to share it across runs.
 */
export function workforceRunner(
  server: Script,
  gateway: Script = {},
  stateDir: string = mkdtempSync(join(tmpdir(), "grokbot-workforce-")),
) {
  const log: Recorded[] = [];
  const queues = new Map<string, unknown[]>();
  const respond = (via: Recorded["via"], script: Script, method: string) => {
    return (body: JsonObject, confirmed: boolean): unknown => {
      log.push({ via, method, body, confirmed });
      const scripted = script[method];
      if (typeof scripted === "function") return scripted(body);
      if (!scripted) throw new Error(`fake ${via}: unscripted call ${method}`);
      const key = `${via}:${method}`;
      const queue = queues.get(key) ?? [...scripted];
      queues.set(key, queue);
      return queue.length > 1 ? queue.shift() : queue[0];
    };
  };
  const serverT: ServerTransport = {
    async call(method, body, options = {}) {
      assertMethodAllowed(method, options.confirmed === true);
      return respond(
        "server",
        server,
        method,
      )(body, options.confirmed === true);
    },
    stream(method) {
      throw new Error(`fake server: no stream ${method} in workforce tests`);
    },
  };
  const gatewayT: GatewayTransport = {
    async call(method, body, options = {}) {
      assertGatewayMethodAllowed(method, options.confirmed === true);
      return respond(
        "gateway",
        gateway,
        method,
      )(body, options.confirmed === true);
    },
  };
  const runner = createCommandRunner({
    server: serverT,
    gateway: gatewayT,
    jobs: jobStore(join(stateDir, "jobs")),
  });
  return { runner, log, stateDir };
}

export const methods = (log: readonly Recorded[]) =>
  log.map((c) => `${c.via}:${c.method}`);

export const bodyOf = (log: readonly Recorded[], method: string) =>
  log.find((c) => c.method === method)?.body;
