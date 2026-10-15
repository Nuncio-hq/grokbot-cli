import type { RunningReason, WaitEvent } from "grokbot-core";

const RUNNING: { readonly [R in RunningReason]: string } = {
  "awaiting-echo": "waiting for the message echo",
  "target-active": "agent is working",
  "subagents-active": "subagents are working",
  "pending-delegation": "waiting on a delegated agent",
  "awaiting-final-reply": "waiting for the final reply",
};

/** One stderr line per meaningful wait event; raw stream frames stay silent. */
export function progressLine(event: WaitEvent): string | undefined {
  switch (event.type) {
    case "verdict":
      return event.verdict.status === "running"
        ? `… ${RUNNING[event.verdict.reason]}\n`
        : undefined;
    case "reconnecting":
      return `… reconnecting: ${event.reason}\n`;
    case "stream":
      return undefined;
  }
}
