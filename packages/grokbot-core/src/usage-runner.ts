import { platform } from "node:os";
import { cliConfigStore } from "./cli-config.js";
import type { CommandName } from "./command-catalog.js";
import type { CommandRunner } from "./command-runner-contract.js";
import { GrokBotError } from "./contracts.js";
import type { ClientLabel } from "./usage-client.js";
import {
  durationBucket,
  localHour,
  type UsageEvent,
  type UsageLog,
  type UsageStatus,
  usageLog,
} from "./usage-log.js";
import { PROTECTED_AGENT_IDS } from "./workforce-protected-agents.js";

const MAIN_BOT_ID = [...PROTECTED_AGENT_IDS][0];

/** Values GROKBOT_USAGE may take to turn the log off for one process. */
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/** On unless GROKBOT_USAGE turns it off or `grokbot config usage off` saved "off". */
export async function usageEnabled(
  env: Readonly<Record<string, string | undefined>>,
  readSetting: () => Promise<"on" | "off"> = async () =>
    (await cliConfigStore().read()).usage,
): Promise<boolean> {
  const value = env.GROKBOT_USAGE?.trim().toLowerCase();
  if (value !== undefined && value !== "") return !OFF_VALUES.has(value);
  return (await readSetting()) === "on";
}

const fieldOf = (output: unknown, key: string): unknown =>
  typeof output === "object" && output !== null
    ? (output as Record<string, unknown>)[key]
    : undefined;

function statusOf(name: CommandName, output: unknown): UsageStatus {
  const outcome = fieldOf(output, "outcome");
  const status = fieldOf(outcome, "status");
  if (typeof status === "string") return status as UsageStatus;
  if (name === "send") return fieldOf(output, "queued") ? "queued" : "sent";
  return "ok";
}

function botOf(output: unknown): UsageEvent["bot"] {
  const id =
    fieldOf(fieldOf(output, "agent"), "agentId") ?? fieldOf(output, "agentId");
  if (typeof id !== "string") return undefined;
  if (id === MAIN_BOT_ID) return "main";
  return PROTECTED_AGENT_IDS.has(id) ? "test" : "other";
}

/** Names of the inputs given a value; the values themselves are never kept. */
function flagNames(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  return Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== false && v !== "")
    .map(([k]) => k)
    .sort();
}

export interface UsageRunnerOptions {
  readonly surface: "cli" | "mcp";
  /** The grokbot version recorded on each event. */
  readonly version: string;
  /** Asked per run, since an MCP client names itself only once it has connected. */
  readonly client: () => ClientLabel;
  readonly enabled: () => Promise<boolean>;
  readonly log?: UsageLog;
  readonly now?: () => number;
}

/**
 * Wraps a runner so each run appends one UsageEvent to the local log. Logging is best
 * effort by design: a full disk or an unreadable setting must never change a command's
 * result, so its errors are dropped, and the command's own error is always rethrown.
 */
export function withUsageLog(
  runner: CommandRunner,
  {
    surface,
    version,
    client,
    enabled,
    log = usageLog(),
    now = Date.now,
  }: UsageRunnerOptions,
): CommandRunner {
  const record = async (
    name: CommandName,
    input: unknown,
    startedMs: number,
    output: unknown,
    error: unknown,
  ) => {
    try {
      if (!(await enabled())) return;
      const bot = error === undefined ? botOf(output) : undefined;
      const event: UsageEvent = {
        v: 1,
        hour: localHour(startedMs),
        command: name,
        surface,
        client: client(),
        status: error === undefined ? statusOf(name, output) : "error",
        ...(error !== undefined && {
          errorCode: error instanceof GrokBotError ? error.code : "other",
        }),
        duration: durationBucket(now() - startedMs),
        flags: flagNames(input),
        ...(bot !== undefined && { bot }),
        version,
        os: platform(),
      };
      await log.append(event, now());
    } catch {
      // Best effort, see above.
    }
  };
  return {
    async run(name, input, options) {
      const startedMs = now();
      try {
        const output = await runner.run(name, input, options);
        await record(name, input, startedMs, output, undefined);
        return output;
      } catch (error) {
        await record(name, input, startedMs, undefined, error);
        throw error;
      }
    },
  };
}
