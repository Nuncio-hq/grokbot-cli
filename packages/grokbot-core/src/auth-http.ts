import { GrokBotError } from "./contracts.js";
import { proxyFetch } from "./network-fetch.js";
import { ProxyError } from "./proxy-config.js";
import type { FetchLike } from "./server-transport.js";

/** The pair every sign-in path returns. Both are JWTs; never print either. */
export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
}

const DEFAULT_API_URL = "https://api2.cursor.sh";
const DEFAULT_WEBSITE_URL = "https://cursor.com";
/** No single auth request may hang a long-running host (e.g. grokbot-mcp). */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Where the auth endpoints live. Overrides use GROKBOT_-prefixed variables so a
 * global CURSOR_API_BASE_URL (meant for the Cursor app) never redirects grokbot's
 * refresh token to another host.
 */
export interface AuthEndpoints {
  readonly apiUrl?: string;
  readonly websiteUrl?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export function apiUrlOf(endpoints: AuthEndpoints): string {
  return safeBaseUrl(
    endpoints.apiUrl ?? process.env.GROKBOT_API_BASE_URL ?? DEFAULT_API_URL,
  );
}

export function websiteUrlOf(endpoints: AuthEndpoints): string {
  return safeBaseUrl(
    endpoints.websiteUrl ??
      process.env.GROKBOT_WEBSITE_URL ??
      DEFAULT_WEBSITE_URL,
  );
}

/** HTTPS only (plain http just for localhost), origin only, so a token never leaves over cleartext. */
function safeBaseUrl(raw: string): string {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  const local = url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
  if (
    !url ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  ) {
    throw new GrokBotError(
      "auth",
      "The GrokBot sign-in URL override must be an https:// address.",
    );
  }
  return url.origin;
}

function fetchOf(endpoints: AuthEndpoints): FetchLike {
  return endpoints.fetch ?? proxyFetch;
}

/**
 * One auth request with a timeout, never leaking what it sent: a synchronous throw,
 * a network error, or a timeout all become one plain `http` error naming only `what`.
 * The caller's signal still aborts it (its reason is rethrown unchanged).
 */
export async function authFetch(
  endpoints: AuthEndpoints,
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const caller = init.signal ?? undefined;
  const timer = AbortSignal.timeout(
    endpoints.timeoutMs ?? AUTH_REQUEST_TIMEOUT_MS,
  );
  const signal = caller ? AbortSignal.any([caller, timer]) : timer;
  try {
    return await fetchOf(endpoints)(url, { ...init, signal });
  } catch (error) {
    if (caller?.aborted) throw caller.reason;
    // A proxy refusal or bad proxy setting: its message names only the proxy's host:port.
    if (error instanceof ProxyError) throw error;
    throw new GrokBotError(
      "http",
      timer.aborted
        ? `${what} timed out after ${Math.round((endpoints.timeoutMs ?? AUTH_REQUEST_TIMEOUT_MS) / 1000)} s.`
        : `${what} failed on the network.`,
    );
  }
}

/** The app's error body when a device-management policy blocks sign-in. */
const SIGN_IN_POLICY_VIOLATION = "sign_in_policy_violation";

/** A fresh error per throw, so stacks point at the real call site. */
export const policyBlocked = () =>
  new GrokBotError(
    "auth",
    "Sign-in on this device is blocked by your organization's device policy.",
  );

/**
 * The server definitely ended the saved sign-in (`shouldLogout`, 401, or OAuth
 * `invalid_grant`). Only this error means "sign in again"; every other refresh
 * failure leaves the saved sign-in alone.
 */
export class SignInEndedError extends GrokBotError {
  constructor() {
    super(
      "auth",
      "The saved GrokBot sign-in has ended. Run grokbot login again, or grokbot logout to use the Grok Bot app's login.",
    );
    this.name = "SignInEndedError";
  }
}

/** True for an HTTP 403 whose body names the device sign-in policy. */
export async function isPolicyBlocked(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === SIGN_IN_POLICY_VIOLATION
  );
}

/** `{accessToken, refreshToken}` with both non-empty strings, else undefined. */
export function parseTokenPair(value: unknown): TokenPair | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { accessToken, refreshToken } = value as Record<string, unknown>;
  return typeof accessToken === "string" &&
    accessToken.length > 0 &&
    typeof refreshToken === "string" &&
    refreshToken.length > 0
    ? { accessToken, refreshToken }
    : undefined;
}
