import { CLIENT_NAMES, type ClientLabel } from "./usage-client.js";

/**
 * The agent runtime's display name, built by grokbot so an agent never has to name itself.
 * Undefined for a person typing and for a host that gave no caller: neither has a runtime.
 */
export function runtimeName(
  caller: ClientLabel | undefined,
): string | undefined {
  return caller === undefined || caller === "human"
    ? undefined
    : CLIENT_NAMES[caller];
}

const LEADING_BRACKET = /^\[[^\]\n]*\]/;

/**
 * `text` behind the one header every message grokbot sends for an agent starts with:
 * `[Project: <label> · Runtime: <name> · Session: <address> · Job: <job8>] `, each part only
 * when known: no project label, no `Project`; a person typing (no runtime), no `Runtime`,
 * no `Session` and no `Job`; no session found, no `Session`. `address` is the caller's
 * `<runtime>:<id>`; `job` is the first 8 characters of the job this message starts, the
 * handle a bot copies into `--re-job` and a session waits on.
 *
 * Applied once. Text that already starts with the same header is left alone. Text that
 * starts with an older grokbot header for this project and runtime (`[<project>]`,
 * `[<project> · <runtime>]`, `[<runtime>]`, or the current shape with another or no
 * session) gets the header in its place instead of a second one. Matching ignores case and
 * leading blanks.
 */
export function withMessageTag(
  text: string,
  label: string | undefined,
  caller: ClientLabel | undefined,
  address?: string,
  job?: string,
): string {
  const runtime = runtimeName(caller);
  const known = [
    ...(label === undefined ? [] : [`Project: ${label}`]),
    ...(runtime === undefined ? [] : [`Runtime: ${runtime}`]),
  ].join(" · ");
  if (known === "") return text;
  const inner =
    runtime === undefined
      ? known
      : [
          known,
          ...(address === undefined ? [] : [`Session: ${address}`]),
          ...(job === undefined ? [] : [`Job: ${job}`]),
        ].join(" · ");
  const tag = `[${inner}]`;
  const body = text.trimStart();
  const lead = LEADING_BRACKET.exec(body)?.[0];
  if (lead === undefined) return `${tag} ${text}`;
  const found = lead.slice(1, -1).toLowerCase();
  if (found === inner.toLowerCase()) return text;
  const lowerKnown = known.toLowerCase();
  const ours =
    [
      label,
      label === undefined || runtime === undefined
        ? undefined
        : `${label} · ${runtime}`,
      label === undefined ? runtime : undefined,
    ].some((older) => older?.toLowerCase() === found) ||
    found === lowerKnown ||
    found.startsWith(`${lowerKnown} · session: `) ||
    found.startsWith(`${lowerKnown} · job: `);
  return ours ? `${tag}${body.slice(lead.length)}` : `${tag} ${text}`;
}
