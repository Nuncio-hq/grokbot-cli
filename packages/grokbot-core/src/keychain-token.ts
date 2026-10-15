import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GrokBotError } from "./contracts.js";

const SECRETS_PATH = [
  "Library",
  "Application Support",
  "Grok Bot",
  "sand-secrets.json",
] as const;
const KEYCHAIN_SERVICE = "Grok Bot Safe Storage";
const KEYCHAIN_ACCOUNT = "Grok Bot Key";
const V10_PREFIX = "v10";

/** Where the token comes from. Every source is injectable so tests use fakes. */
export interface GrokBotTokenSources {
  readonly platform?: string;
  readonly readSecretsFile?: () => Promise<string>;
  readonly readKeychainPassword?: () => Promise<string>;
}

/** Decrypts an Electron safeStorage v10 blob (macOS Keychain scheme). */
export function decryptSafeStorageV10(
  blob: Uint8Array,
  password: string,
): string {
  const bytes = Buffer.from(blob);
  if (bytes.subarray(0, V10_PREFIX.length).toString("latin1") !== V10_PREFIX) {
    throw new GrokBotError(
      "auth",
      "The Grok Bot token is not in safeStorage v10 format.",
    );
  }
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  try {
    const decipher = createDecipheriv(
      "aes-128-cbc",
      key,
      Buffer.alloc(16, 0x20),
    );
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(V10_PREFIX.length)),
      decipher.final(),
    ]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new GrokBotError(
      "auth",
      "Cannot decrypt the Grok Bot token. Open the Grok Bot app once to refresh it.",
    );
  }
}

/**
 * Reads and decrypts the Grok Bot app's access token. Reads the account file
 * and the Keychain on every call and never caches the result.
 */
export async function readGrokBotAccessToken(
  sources: GrokBotTokenSources = {},
): Promise<string> {
  const {
    platform = process.platform,
    readSecretsFile = readDefaultSecretsFile,
    readKeychainPassword = readDefaultKeychainPassword,
  } = sources;
  if (platform !== "darwin") {
    throw new GrokBotError(
      "auth",
      "GrokBot auth needs macOS with the Grok Bot app installed and logged in.",
    );
  }

  const fileText = await readSecretsFile().catch(() => {
    throw new GrokBotError(
      "auth",
      "Cannot read the Grok Bot account file. Install the Grok Bot app and log in once.",
    );
  });
  const encrypted = parseActiveAccessToken(fileText);
  if (encrypted === undefined) {
    throw new GrokBotError(
      "auth",
      "The Grok Bot account file has an unexpected shape. Open the Grok Bot app and log in again.",
    );
  }
  const password = await readKeychainPassword().catch(() => {
    throw new GrokBotError(
      "auth",
      `Cannot read the "${KEYCHAIN_SERVICE}" Keychain item. Open the Grok Bot app once and allow Keychain access.`,
    );
  });
  return decryptSafeStorageV10(Buffer.from(encrypted, "base64"), password);
}

function parseActiveAccessToken(fileText: string): string | undefined {
  try {
    const file: unknown = JSON.parse(fileText);
    const accountsText = isRecord(file) ? file["cursor-accounts"] : undefined;
    if (typeof accountsText !== "string") return undefined;
    const state: unknown = JSON.parse(accountsText);
    if (!isRecord(state) || typeof state.active !== "string") return undefined;
    const { accounts, active } = state;
    if (!isRecord(accounts) || !Object.hasOwn(accounts, active)) {
      return undefined;
    }
    const account = accounts[active];
    const token = isRecord(account)
      ? account["cursor-access-token"]
      : undefined;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

function readDefaultSecretsFile(): Promise<string> {
  return readFile(join(homedir(), ...SECRETS_PATH), "utf8");
}

async function readDefaultKeychainPassword(): Promise<string> {
  const { stdout } = await promisify(execFile)("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  return stdout.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
