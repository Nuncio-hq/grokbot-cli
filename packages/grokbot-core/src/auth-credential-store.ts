import { parseTokenPair, type TokenPair } from "./auth-http.js";
import {
  type KeychainRunner,
  runSecurity,
  SECURITY_NOT_FOUND,
  SECURITY_NOT_RUNNABLE,
  SECURITY_PROMPT_TIMEOUT_MS,
} from "./auth-security-runner.js";
import { cliConfigStore, type KeychainAccess } from "./cli-config.js";
import { GrokBotError } from "./contracts.js";
import { addItemLine, itemAccessOf } from "./keychain-items.js";

export type { KeychainRunner } from "./auth-security-runner.js";

/**
 * Where `grokbot login` keeps its own sign-in: one macOS Keychain item, separate from
 * the GrokBot app's "Grok Bot Safe Storage". Allowed by the amended hard Rule 3
 * (docs/index.html#rules): only the OS credential store, never a plaintext file.
 *
 * Access mode (`grokbot config keychain-access`): "silent" items trust /usr/bin/security,
 * so any process of this user reads them without a dialog. "prompt" items trust no app
 * (`-T ""`), so macOS asks before each process reads. Verified on a temp keychain:
 * `-U` keeps an item's ACL, and attribute reads (no `-w`) never ask.
 */
const SERVICE = "grokbot-cli";
const ACCOUNT = "default";

/** What sign-in and refresh need: load, save, clear. */
export interface TokenPairStore {
  load(): Promise<TokenPair | undefined>;
  save(pair: TokenPair): Promise<void>;
  /** True when a saved pair was removed. */
  clear(): Promise<boolean>;
}

export interface CredentialStore extends TokenPairStore {
  /** The mode the saved item really has (from its label, no token read); undefined if none. */
  itemAccess(): Promise<KeychainAccess | undefined>;
  /** Re-creates a saved item with `access`; the old item is restored if that fails. */
  setAccess(access: KeychainAccess): Promise<{ readonly migrated: boolean }>;
}

export interface CredentialStoreOptions {
  readonly platform?: string;
  readonly run?: KeychainRunner;
  /** The configured mode for new items. Default: ~/.grokbot/grokbot-cli.json. */
  readonly access?: () => Promise<KeychainAccess>;
}

export function credentialStore(
  options: CredentialStoreOptions = {},
): CredentialStore {
  const {
    platform = process.platform,
    run = runSecurity,
    access = async () => (await cliConfigStore().read()).keychainAccess,
  } = options;
  const onMac = platform === "darwin";
  // Prompt mode only: one Keychain read (one dialog) per process.
  let cached: TokenPair | undefined;

  const requireMac = () => {
    if (!onMac) {
      throw new GrokBotError(
        "auth",
        "grokbot login stores its sign-in in the macOS Keychain, so it needs macOS.",
      );
    }
  };

  const readValue = async (mode: KeychainAccess) => {
    const timeoutMs =
      mode === "prompt" ? SECURITY_PROMPT_TIMEOUT_MS : undefined;
    return run(
      ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"],
      undefined,
      timeoutMs ? { timeoutMs } : undefined,
    );
  };

  const addLine = (value: string, mode: KeychainAccess, update: boolean) => {
    const line = addItemLine(
      { account: ACCOUNT, service: SERVICE },
      value,
      mode,
      update,
    );
    if (line === undefined) {
      throw new GrokBotError(
        "auth",
        "The GrokBot sign-in is too large for the Keychain helper; nothing was saved.",
      );
    }
    return line;
  };

  const store: CredentialStore = {
    async load() {
      if (!onMac) return undefined;
      if (cached) return cached;
      const mode = (await store.itemAccess()) ?? "silent";
      const { code, stdout } = await readValue(mode);
      if (code === 0) {
        const pair = decode(stdout.trim());
        if (mode === "prompt") cached = pair;
        return pair;
      }
      // Not found, or no `security` at all: nobody ran grokbot login, so use the app.
      if (code === SECURITY_NOT_FOUND || code === SECURITY_NOT_RUNNABLE) {
        return undefined;
      }
      // Denied, timed out, or locked is not "signed out": falling back would switch account.
      throw new GrokBotError(
        "auth",
        mode === "prompt"
          ? `macOS did not allow reading the grokbot sign-in (keychain access is "prompt"; security exited ${code}). Click Allow on the dialog, or run grokbot config keychain-access silent.`
          : `Cannot read the grokbot sign-in from the Keychain (security exited ${code}). Unlock the login keychain and retry.`,
      );
    },

    async save(pair) {
      requireMac();
      // A brand-new item takes the configured mode; an existing one keeps its own (-U).
      const existing = await store.itemAccess();
      const mode = existing ?? (await access());
      const { code } = await run(["-i"], addLine(encode(pair), mode, true));
      if (code !== 0) {
        throw new GrokBotError(
          "auth",
          `Cannot save the GrokBot sign-in to the Keychain (security exited ${code}).`,
        );
      }
      if (cached) cached = pair;
    },

    async clear() {
      if (!onMac) return false;
      cached = undefined;
      const { code } = await run([
        "delete-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        SERVICE,
      ]);
      if (code === 0) return true;
      if (code === SECURITY_NOT_FOUND) return false;
      throw new GrokBotError(
        "auth",
        `Cannot remove the GrokBot sign-in from the Keychain (security exited ${code}).`,
      );
    },

    async itemAccess() {
      if (!onMac) return undefined;
      // Attributes only (no -w): never shows a dialog, never reads the token.
      const { code, stdout } = await run([
        "find-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        SERVICE,
      ]);
      return code === 0 ? itemAccessOf(stdout) : undefined;
    },

    async setAccess(next) {
      requireMac();
      const current = await store.itemAccess();
      if (current === undefined) return { migrated: false };
      // The value must be read once; in prompt mode this is the one dialog.
      const { code: readCode, stdout } = await readValue(current);
      if (readCode !== 0) {
        throw new GrokBotError(
          "auth",
          `Cannot read the grokbot sign-in to switch its access (security exited ${readCode}); nothing was changed.`,
        );
      }
      const value = stdout.trim();
      // An item's access list cannot be swapped in place without a dialog, so re-create it.
      const { code: delCode } = await run([
        "delete-generic-password",
        "-a",
        ACCOUNT,
        "-s",
        SERVICE,
      ]);
      if (delCode !== 0) {
        throw new GrokBotError(
          "auth",
          `Cannot switch the grokbot sign-in to ${next} access (security exited ${delCode}); nothing was changed.`,
        );
      }
      const { code } = await run(["-i"], addLine(value, next, false));
      if (code !== 0) {
        // Put the previous item back so the sign-in is never lost.
        await run(["-i"], addLine(value, current, false));
        throw new GrokBotError(
          "auth",
          `Cannot switch the grokbot sign-in to ${next} access (security exited ${code}); the previous item was kept.`,
        );
      }
      cached = undefined;
      return { migrated: true };
    },
  };
  return store;
}

/** base64url(JSON): no spaces or quotes, so the `security -i` line parses unambiguously. */
function encode(pair: TokenPair): string {
  return Buffer.from(JSON.stringify(pair), "utf8").toString("base64url");
}

function decode(value: string): TokenPair | undefined {
  try {
    return parseTokenPair(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}
