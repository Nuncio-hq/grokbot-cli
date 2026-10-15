import {
  credentialStore,
  type TokenPairStore,
} from "./auth-credential-store.js";
import {
  type AuthEndpoints,
  type TokenPair,
  websiteUrlOf,
} from "./auth-http.js";
import { buildLoginUrl, createPkcePair, type PkcePair } from "./auth-pkce.js";
import { pollLoginResult } from "./auth-poll.js";
import { exchangeApiKey } from "./auth-refresh.js";
import { GrokBotError } from "./contracts.js";

export interface LoginResult {
  readonly method: "browser" | "api-key";
}

/** Checked first: the sign-in can only be kept in the macOS Keychain. */
function requireMac(platform: string = process.platform): void {
  if (platform !== "darwin") {
    throw new GrokBotError(
      "auth",
      "grokbot login stores its sign-in in the macOS Keychain, so it needs macOS.",
    );
  }
}

export interface BrowserLoginOptions extends AuthEndpoints {
  readonly store?: TokenPairStore;
  /** Prints the sign-in URL (and a QR) so the owner can finish on any device. */
  readonly showUrl: (url: string) => void;
  /** Opens the URL locally; a failure is not fatal because the URL was already shown. */
  readonly openUrl: (url: string) => Promise<void>;
  /** False on a remote or headless machine: show the URL only. Default true. */
  readonly openBrowser?: boolean;
  readonly signal?: AbortSignal;
  readonly platform?: string;
  readonly pkce?: () => PkcePair;
  readonly poll?: (
    pair: Pick<PkcePair, "uuid" | "verifier">,
    signal?: AbortSignal,
  ) => Promise<TokenPair>;
}

/**
 * Headless PKCE sign-in, the same flow as the GrokBot app: show the cursor.com URL,
 * wait on `/auth/poll`, then keep the pair in the Keychain. Any email, password, 2FA or
 * OTP is entered on the web page; the CLI never sees it.
 */
export async function loginWithBrowser(
  options: BrowserLoginOptions,
): Promise<LoginResult> {
  const {
    store = credentialStore(),
    openBrowser = true,
    signal,
    pkce = () => createPkcePair(),
    poll = (pair, s) => pollLoginResult(pair, { ...options, signal: s }),
  } = options;
  requireMac(options.platform);
  const pair = pkce();
  const url = buildLoginUrl(pair, websiteUrlOf(options));
  options.showUrl(url);
  if (openBrowser) await options.openUrl(url).catch(() => undefined);
  const tokens = await poll(
    { uuid: pair.uuid, verifier: pair.verifier },
    signal,
  );
  await store.save(tokens);
  return { method: "browser" };
}

export interface ApiKeyLoginOptions extends AuthEndpoints {
  readonly store?: TokenPairStore;
  readonly exchange?: (apiKey: string) => Promise<TokenPair>;
  readonly platform?: string;
}

/** Non-interactive sign-in for CI: trades a Cursor API key for a token pair. */
export async function loginWithApiKey(
  apiKey: string,
  options: ApiKeyLoginOptions = {},
): Promise<LoginResult> {
  requireMac(options.platform);
  const key = apiKey.trim();
  if (key === "") throw new GrokBotError("auth", "The API key is empty.");
  const {
    store = credentialStore(),
    exchange = (k) => exchangeApiKey(k, options),
  } = options;
  await store.save(await exchange(key));
  return { method: "api-key" };
}
