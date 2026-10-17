import type { KeychainAccess } from "./cli-config.js";

/** One generic-password item in the login keychain. Account and service carry no spaces. */
export interface KeychainItem {
  readonly account: string;
  readonly service: string;
}

/** Marks the access mode an item was made with, in its comment attribute. */
const COMMENT_PREFIX = "grokbot-cli-access=";
/** `security -i` reads about 4096 bytes per line and runs the rest as a new command. */
const MAX_LINE_BYTES = 4000;

/**
 * One `security -i` add line; the value rides on stdin, never argv. Undefined when the
 * line is too long: it would be split, storing a truncated value over a good one.
 * "prompt" items trust no app (`-T ""`), so macOS asks before each process reads them.
 */
export function addItemLine(
  { account, service }: KeychainItem,
  value: string,
  mode: KeychainAccess,
  update: boolean,
): string | undefined {
  const trust = mode === "prompt" ? ' -T ""' : "";
  const upsert = update ? " -U" : "";
  const line = `add-generic-password${upsert} -a ${account} -s ${service} -j ${COMMENT_PREFIX}${mode}${trust} -w ${value}\n`;
  return Buffer.byteLength(line) > MAX_LINE_BYTES ? undefined : line;
}

/** The access mode in an item's attributes (`find-generic-password` without -w). */
export function itemAccessOf(attributes: string): KeychainAccess {
  const label = new RegExp(
    `"icmt"<blob>="${COMMENT_PREFIX}(silent|prompt)"`,
  ).exec(attributes);
  // Items saved before the setting existed carry no label and trust /usr/bin/security.
  return (label?.[1] as KeychainAccess | undefined) ?? "silent";
}
