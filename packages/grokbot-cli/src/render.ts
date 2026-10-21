import type { CommandName, CommandOutputs } from "grokbot-core";
import { type ExitCode, exitCodeFor } from "./exit-codes.js";
import { DISPATCH_RENDERERS } from "./render-dispatch.js";
import { GOVERNANCE_RENDERERS } from "./render-governance.js";
import { INBOX_RENDERERS } from "./render-inbox.js";
import type { HumanRenderer, HumanRenderers, Text } from "./render-parts.js";
import { WORKFORCE_RENDERERS } from "./render-workforce.js";

/** What one command prints: `stdout` is the result, `note` is a human hint for stderr. */
export interface Rendered extends Text {
  readonly exit: ExitCode;
}

const HUMAN: HumanRenderers<CommandName> = {
  ...DISPATCH_RENDERERS,
  ...WORKFORCE_RENDERERS,
  ...GOVERNANCE_RENDERERS,
  ...INBOX_RENDERERS,
};

/** Pure: typed command output in, terminal text and exit code out. */
export function renderOutput<N extends CommandName>(
  name: N,
  output: CommandOutputs[N],
  json: boolean,
): Rendered {
  const exit = exitCodeFor(name, output);
  if (json) {
    return { stdout: `${JSON.stringify(output, null, 2)}\n`, note: "", exit };
  }
  const human: HumanRenderer<N> = HUMAN[name];
  return { ...human(output), exit };
}
