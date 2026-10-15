import { PassThrough } from "node:stream";
import type {
  Agent,
  AgentId,
  CommandInput,
  CommandName,
  CommandOutput,
  CommandRunner,
  RunOptions,
} from "grokbot-core";
import { serve } from "../server.js";

export const PRIMARY_TEST: Agent = {
  kind: "agent",
  agentId: "f882ec52-17b1-4639-b0fc-07fed7526b09" as AgentId,
  rowId: "101",
  name: "Primary Test",
  title: "",
  description: "",
  harness: "",
};

export interface RunCall {
  readonly name: CommandName;
  readonly input: unknown;
  readonly signal: AbortSignal | undefined;
}

export function fakeRunner(respond: (call: RunCall) => Promise<unknown>) {
  const calls: RunCall[] = [];
  const runner: CommandRunner = {
    run<N extends CommandName>(
      name: N,
      input: CommandInput<N>,
      options?: RunOptions,
    ) {
      const call = { name, input, signal: options?.signal };
      calls.push(call);
      return respond(call) as Promise<CommandOutput<N>>;
    },
  };
  return { runner, calls };
}

export const unusedRunner = fakeRunner(() =>
  Promise.reject(new Error("runner must not be called")),
).runner;

/** Drives `serve` over in-memory streams the way an MCP client drives stdio. */
export function startSession(runner: CommandRunner) {
  const input = new PassThrough();
  const messages: unknown[] = [];
  const logs: string[] = [];
  const done = serve({
    input,
    output: { write: (chunk: string) => messages.push(JSON.parse(chunk)) },
    runner,
    log: (line) => logs.push(line),
  });
  return {
    send(message: unknown): void {
      const line =
        typeof message === "string" ? message : JSON.stringify(message);
      input.write(`${line}\n`);
    },
    async close(): Promise<unknown[]> {
      input.end();
      await done;
      return messages;
    },
    logs,
  };
}

export async function exchange(
  runner: CommandRunner,
  ...lines: unknown[]
): Promise<unknown[]> {
  const session = startSession(runner);
  for (const line of lines) session.send(line);
  return session.close();
}
