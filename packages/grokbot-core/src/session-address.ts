/**
 * The address of one agent session: `<runtime>:<id>`, as grokbot writes it in a message's
 * header and an inbox item's `to.session`. Pure text rules, shared by the detector that
 * finds the caller's session and by the inbox validators that check an address a bot copied.
 */

/** The runtime part: a client label such as the ones `detectClient` returns. */
const RUNTIME = "[a-z][a-z0-9-]{1,39}";
/** The id part, as a runtime shows it: letters, digits, `.`, `_` and `-`. */
const ID = "[A-Za-z0-9._-]{4,100}";

/** A whole address, as a JSON Schema `pattern`. */
export const SESSION_ADDRESS_PATTERN = `^${RUNTIME}:${ID}$`;
/** Longest address: 40 characters of runtime, a colon, 100 of id. */
export const SESSION_ADDRESS_MAX_LENGTH = 141;

const RUNTIME_PART = new RegExp(`^${RUNTIME}$`);
const ID_PART = new RegExp(`^${ID}$`);

const isSessionRuntime = (value: string): boolean => RUNTIME_PART.test(value);

export const isSessionId = (value: string): boolean => ID_PART.test(value);

interface SessionParts {
  readonly runtime: string;
  readonly id: string;
}

/** The parts of an address, or undefined when `value` is not exactly `<runtime>:<id>`. */
export function parseSessionAddress(value: string): SessionParts | undefined {
  const colon = value.indexOf(":");
  if (colon < 0) return undefined;
  const runtime = value.slice(0, colon);
  const id = value.slice(colon + 1);
  return isSessionRuntime(runtime) && isSessionId(id)
    ? { runtime, id }
    : undefined;
}
