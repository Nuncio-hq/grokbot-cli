import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import type { GovernanceCommandName } from "./command-specs-governance.js";
import {
  callMcp,
  listComputers,
  listMcp,
  openVnc,
} from "./governance-box-handlers.js";
import {
  answerWidget,
  listApprovals,
  resolveCard,
} from "./governance-card-handlers.js";
import {
  defaultSleep,
  listCloudAgents,
  type Sleep,
  showCloudAgent,
} from "./governance-cloud-agent-handlers.js";
import {
  defaultGovernanceDeps,
  type GovernanceDeps,
} from "./governance-deps.js";
import { previewWorker, startWorker } from "./governance-worker-handlers.js";

/** Options a test passes to replace every governance side effect. */
interface GovernanceHandlerOptions {
  readonly deps?: GovernanceDeps;
  readonly cliPath?: string;
  /** Pauses between `cloud-agent --wait` polls; a test passes a fake clock's. */
  readonly sleep?: Sleep;
}

export function governanceHandlers(
  ctx: RunnerContext,
  options: GovernanceHandlerOptions = {},
): CommandHandlers<GovernanceCommandName> {
  const deps = options.deps ?? defaultGovernanceDeps();
  const sleep = options.sleep ?? defaultSleep;
  const cliPath =
    options.cliPath ?? join(homedir(), ".local", "bin", "cursor-agent");
  return {
    approvals: (input, { signal }) => listApprovals(ctx, input.agent, signal),
    answer: (input, { signal }) => answerWidget(ctx, input, signal),
    approve: (input, run) => resolveCard(ctx, deps, "approve", input, run),
    deny: (input, run) => resolveCard(ctx, deps, "deny", input, run),
    computers: (_input, { signal }) => listComputers(ctx, signal),
    "mcp-list": (_input, { signal }) => listMcp(ctx, signal),
    "mcp-call": (input, run) => callMcp(ctx, input, run),
    vnc: (input, { signal }) => openVnc(ctx, deps, input, signal),
    "worker-plan": (input, { signal }) =>
      previewWorker(ctx, deps, input, cliPath, signal),
    "worker-start": (input, { signal }) =>
      startWorker(deps, input, cliPath, signal),
    "cloud-agents": (input, { signal }) => listCloudAgents(ctx, input, signal),
    "cloud-agent": (input, { signal }) =>
      showCloudAgent(ctx, sleep, input, signal),
  };
}
