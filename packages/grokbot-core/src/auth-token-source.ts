import {
  type CredentialStore,
  credentialStore,
  type TokenPairStore,
} from "./auth-credential-store.js";
import { SignInEndedError, type TokenPair } from "./auth-http.js";
import {
  needsRefresh,
  refreshTokenPair,
  tokenExpiresAt,
} from "./auth-refresh.js";
import type { KeychainAccess } from "./cli-config.js";
import { GrokBotError } from "./contracts.js";
import { readGrokBotAccessToken } from "./keychain-token.js";

/** Which sign-in the next call will use. Never carries a token. */
export type SignInInfo =
  | {
      readonly source: "cli";
      readonly expiresAt?: number;
      readonly keychainAccess?: KeychainAccess;
    }
  | { readonly source: "app" }
  | { readonly source: "none" };

export interface TokenSource {
  /**
   * A valid access token, refreshed when near expiry. Kept in memory for up to
   * TOKEN_REUSE_MS so a burst of calls reads the Keychain once; never written anywhere.
   */
  getToken(): Promise<string>;
  describe(): Promise<SignInInfo>;
}

interface TokenSourceOptions {
  /** `itemAccess` is optional: when present, describe() reports the mode without a dialog. */
  readonly store?: TokenPairStore &
    Partial<Pick<CredentialStore, "itemAccess">>;
  /** The desktop app's token (today's default). */
  readonly readAppToken?: () => Promise<string>;
  readonly refresh?: (refreshToken: string) => Promise<TokenPair>;
  readonly now?: () => number;
}

/**
 * How long one resolved token serves later calls. Short, so a long-lived host (the MCP
 * server) sees a login, logout, or app account switch within a minute.
 */
export const TOKEN_REUSE_MS = 60_000;

/**
 * Order: the CLI's own `grokbot login` sign-in (refreshed when near expiry), else the
 * GrokBot desktop app's token.
 *
 * Safety rules, so a request never silently runs as a different account:
 * - Only SignInEndedError ends the CLI sign-in. That call fails with the message; the
 *   pair is removed, and later calls use the app's token.
 * - Before removing, the store is re-read: another grokbot process may have rotated
 *   the pair while this one refreshed with the old refresh token.
 * - Any other refresh failure keeps the pair and uses the access token while it is
 *   still valid.
 * - A failed save still returns the fresh token; the old item stays until next time.
 */
export function createTokenSource(
  options: TokenSourceOptions = {},
): TokenSource {
  const {
    store = credentialStore(),
    readAppToken = () => readGrokBotAccessToken(),
    refresh = (refreshToken) => refreshTokenPair(refreshToken),
    now = Date.now,
  } = options;
  let inFlight: Promise<string> | undefined;
  let reused: { readonly token: string; readonly until: number } | undefined;

  const stillValid = (accessToken: string) => {
    const expiresAt = tokenExpiresAt(accessToken);
    return expiresAt !== undefined && expiresAt > now();
  };

  const fromApp = async (): Promise<string> => {
    try {
      return await readAppToken();
    } catch (appError) {
      const why = appError instanceof Error ? ` (${appError.message})` : "";
      throw new GrokBotError(
        "auth",
        `Not signed in. Run grokbot login, or open the Grok Bot app and log in.${why}`,
      );
    }
  };

  const refreshed = async (
    pair: TokenPair,
    retried = false,
  ): Promise<string> => {
    let next: TokenPair;
    try {
      next = await refresh(pair.refreshToken);
    } catch (error) {
      if (!(error instanceof SignInEndedError)) {
        if (stillValid(pair.accessToken)) return pair.accessToken;
        throw error;
      }
      // Another process may have rotated the pair while we used the old refresh token.
      const current = await store.load();
      if (!retried && current && current.refreshToken !== pair.refreshToken) {
        return needsRefresh(current.accessToken, now)
          ? refreshed(current, true)
          : current.accessToken;
      }
      await store.clear();
      throw error;
    }
    await store.save(next).catch(() => undefined);
    return next.accessToken;
  };

  const resolve = async (): Promise<string> => {
    const pair = await store.load();
    if (!pair) return fromApp();
    return needsRefresh(pair.accessToken, now)
      ? refreshed(pair)
      : pair.accessToken;
  };

  return {
    getToken() {
      if (reused && now() < reused.until && !needsRefresh(reused.token, now))
        return Promise.resolve(reused.token);
      reused = undefined;
      inFlight ??= resolve()
        .then((token) => {
          reused = { token, until: now() + TOKEN_REUSE_MS };
          return token;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    async describe() {
      const access = await store.itemAccess?.();
      // A prompt-mode item exists: say so without reading it (reading would show a dialog).
      if (access === "prompt") return { source: "cli", keychainAccess: access };
      const pair = await store.load();
      if (pair) {
        const expiresAt = tokenExpiresAt(pair.accessToken);
        return {
          source: "cli",
          ...(expiresAt !== undefined && { expiresAt }),
          ...(access !== undefined && { keychainAccess: access }),
        };
      }
      try {
        await readAppToken();
        return { source: "app" };
      } catch {
        return { source: "none" };
      }
    },
  };
}
