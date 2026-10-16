import type {
  CommandOutputs,
  CommandRunner,
  CommandRunnerOptions,
  RunEvent,
} from "grokbot-core";
import type { AuthDeps } from "../auth-command.js";
import type { ConfigDeps } from "../config-command.js";
import { main } from "../main.js";
import type { StatsDeps } from "../stats-command.js";

export interface RunCall {
  readonly name: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

export interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly calls: readonly RunCall[];
  readonly runnerOptions: readonly CommandRunnerOptions[];
}

export interface CliSetup {
  readonly outputs?: Partial<CommandOutputs>;
  /** Thrown by runner.run instead of returning an output. */
  readonly error?: unknown;
  /** Thrown by createRunner itself, like the Wave 2A stub. */
  readonly createError?: unknown;
  /** Emitted through RunOptions.onEvent before the output resolves. */
  readonly events?: readonly RunEvent[];
  /** Runner that never settles and ignores the signal, so main must race the abort itself. */
  readonly hangForever?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly isTTY?: boolean;
  readonly signal?: AbortSignal;
  /** Fake auth backend for login/logout/whoami; real deps are never built in tests. */
  readonly auth?: AuthDeps;
  /** Fake settings + Keychain backend for `grokbot config`. */
  readonly config?: ConfigDeps;
  /** Fake usage log and GrokBot reads for `grokbot stats`. */
  readonly stats?: StatsDeps;
}

function collector() {
  const chunks: string[] = [];
  return {
    stream: { write: (text: string) => chunks.push(text) },
    text: () => chunks.join(""),
  };
}

/** Runs `main` the way bin/grokbot does, with a fake runner returning literal outputs. */
export async function runCli(
  argv: readonly string[],
  setup: CliSetup = {},
): Promise<CliRun> {
  const stdout = collector();
  const stderr = collector();
  const calls: RunCall[] = [];
  const runnerOptions: CommandRunnerOptions[] = [];
  const runner: CommandRunner = {
    async run(name, input, options) {
      calls.push({
        name,
        input,
        ...(options?.signal && { signal: options.signal }),
      });
      for (const event of setup.events ?? []) options?.onEvent?.(event);
      if (setup.hangForever) return new Promise<never>(() => {});
      if (setup.error !== undefined) throw setup.error;
      const output = setup.outputs?.[name];
      if (output === undefined) throw new Error(`no fake output for ${name}`);
      return output;
    },
  };
  const code = await main(argv, {
    createRunner: (options) => {
      runnerOptions.push(options);
      if (setup.createError !== undefined) throw setup.createError;
      return runner;
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: setup.env ?? {},
    isTTY: setup.isTTY ?? false,
    ...(setup.signal && { signal: setup.signal }),
    ...(setup.auth && { auth: setup.auth }),
    ...(setup.config && { config: setup.config }),
    ...(setup.stats && { stats: setup.stats }),
  });
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    code,
    calls,
    runnerOptions,
  };
}
