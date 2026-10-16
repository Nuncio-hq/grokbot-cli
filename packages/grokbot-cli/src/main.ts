import {
  type CommandName,
  type CommandOutputs,
  type CommandRunner,
  type CommandRunnerOptions,
  GROKBOT_VERSION,
  parseCommandInput,
  type RunOptions,
} from "grokbot-core";
import type { AuthDeps } from "./auth-command.js";
import type { ConfigDeps } from "./config-command.js";
import { errorMessage } from "./error-message.js";
import { EXIT_CODE } from "./exit-codes.js";
import { commandHelp, generalHelp, usageLine } from "./help.js";
import { localInvocation, runLocal } from "./local-commands.js";
import { cliError, parseArgv } from "./parse-argv.js";
import { progressLine } from "./progress.js";
import { renderOutput } from "./render.js";
import type { StatsDeps } from "./stats-command.js";

export interface TextSink {
  write(text: string): unknown;
}

export interface MainContext {
  /** Called only once argv is valid, so help and usage errors never touch the Keychain. */
  readonly createRunner: (options: CommandRunnerOptions) => CommandRunner;
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stderr is a terminal; progress prints only then. */
  readonly isTTY: boolean;
  /** Aborts the running command (Ctrl-C). */
  readonly signal?: AbortSignal;
  /** Backend of login/logout/whoami; built lazily so other commands never touch it. */
  readonly auth?: AuthDeps;
  /** Backend of `grokbot config`; built lazily like `auth`. */
  readonly config?: ConfigDeps;
  /** Backend of `grokbot stats`; built lazily like `auth`. */
  readonly stats?: StatsDeps;
}

const INTERRUPTED = Symbol("interrupted");

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    const stop = () => reject(INTERRUPTED);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Runs one `grokbot` invocation and returns its exit code. */
export async function main(
  argv: readonly string[],
  context: MainContext,
): Promise<number> {
  const { stdout, stderr } = context;
  const local = localInvocation(argv);
  if (local) return runLocal(local.name, local.args, context);
  const invocation = parseArgv(argv);
  switch (invocation.kind) {
    case "help":
      stdout.write(
        invocation.command ? commandHelp(invocation.command) : generalHelp(),
      );
      return EXIT_CODE.ok;
    case "version":
      stdout.write(`${GROKBOT_VERSION}\n`);
      return EXIT_CODE.ok;
    case "usage-error": {
      const { command, errors } = invocation;
      const scope = command ? `${command.name}: ` : "";
      for (const error of errors) stderr.write(`grokbot: ${scope}${error}\n`);
      stderr.write(`${usageLine(command)}\n`);
      return EXIT_CODE.usage;
    }
    case "run":
      break;
  }

  const { command, raw, json } = invocation;
  const parsed = parseCommandInput(command.name, raw);
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      stderr.write(`grokbot: ${command.name}: ${cliError(command, error)}\n`);
    }
    stderr.write(`${usageLine(command)}\n`);
    return EXIT_CODE.usage;
  }

  const controller = new AbortController();
  const forward = () => controller.abort();
  if (context.signal?.aborted) forward();
  else context.signal?.addEventListener("abort", forward, { once: true });
  const showProgress = context.isTTY && !json;
  let jobId: string | undefined;
  const options: RunOptions = {
    signal: controller.signal,
    // The job id always reaches stderr, even under --json, so Ctrl-C never loses it.
    onEvent: (event) => {
      if (event.type === "dispatched") {
        jobId = event.jobId;
        stderr.write(`job ${jobId}\n`);
      } else if (showProgress) {
        const text = progressLine(event);
        if (text) stderr.write(text);
      }
    },
  };
  const defaultAgent = context.env.GROKBOT_AGENT?.trim();
  try {
    const runner = context.createRunner(defaultAgent ? { defaultAgent } : {});
    const name: CommandName = command.name;
    const output: CommandOutputs[CommandName] = await Promise.race([
      runner.run(name, parsed.input, options),
      untilAborted(controller.signal),
    ]);
    const rendered = renderOutput(name, output, json);
    stdout.write(rendered.stdout);
    if (rendered.note) stderr.write(rendered.note);
    return rendered.exit;
  } catch (error) {
    if (error === INTERRUPTED || controller.signal.aborted) {
      stderr.write("grokbot: interrupted\n");
      if (jobId) stderr.write(`Resume with: grokbot wait ${jobId}\n`);
      return EXIT_CODE.interrupted;
    }
    stderr.write(errorMessage(error));
    return EXIT_CODE.failure;
  } finally {
    context.signal?.removeEventListener("abort", forward);
  }
}
