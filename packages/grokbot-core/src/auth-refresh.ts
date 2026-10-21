import {
  type AuthEndpoints,
  apiUrlOf,
  authFetch,
  isPolicyBlocked,
  parseTokenPair,
  policyBlocked,
  SignInEndedError,
  type TokenPair,
} from "./auth-http.js";
import { GrokBotError } from "./contracts.js";

/**
 * The production auth client id the GrokBot app sends with every refresh
 * (`QM` in electron-main/main-core.cjs, app.asar v0.70.2). Dev and staging hosts use
 * another id; override with GROKBOT_AUTH_CLIENT_ID if Cursor rotates it.
 */
const AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

/** The app refreshes when the access token has under 5 minutes left (`foe`). */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** A blank override falls back to the built-in id instead of sending "". */
const clientId = () =>
  process.env.GROKBOT_AUTH_CLIENT_ID?.trim() || AUTH_CLIENT_ID;

/** The JWT `exp` in epoch milliseconds, or undefined when it cannot be read. */
export function tokenExpiresAt(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function needsRefresh(
  accessToken: string,
  now: () => number = Date.now,
): boolean {
  const expiresAt = tokenExpiresAt(accessToken);
  return expiresAt === undefined || expiresAt - now() < REFRESH_WINDOW_MS;
}

/**
 * `POST /oauth/token` with the refresh grant. Keeps the old refresh token unless rotated.
 * Throws SignInEndedError only when the server definitely ended the sign-in (401,
 * OAuth `invalid_grant`, or `shouldLogout`); any other failure (400, 403, 5xx, network,
 * timeout) is an ordinary error and the caller keeps the saved pair.
 */
export async function refreshTokenPair(
  refreshToken: string,
  endpoints: AuthEndpoints = {},
): Promise<TokenPair> {
  const response = await authFetch(
    endpoints,
    `${apiUrlOf(endpoints)}/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId(),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    "Refreshing the GrokBot sign-in",
  );

  if (await isPolicyBlocked(response)) throw policyBlocked();
  const body: unknown = await response.json().catch(() => null);
  const fields = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  if (
    response.status === 401 ||
    fields.error === "invalid_grant" ||
    fields.shouldLogout === true
  ) {
    throw new SignInEndedError();
  }
  if (!response.ok) {
    throw new GrokBotError(
      "http",
      `Refreshing the GrokBot sign-in failed with HTTP ${response.status}.`,
    );
  }
  const accessToken = fields.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GrokBotError(
      "protocol",
      "Refreshing the GrokBot sign-in returned no access token.",
    );
  }
  const rotated = fields.refresh_token;
  return {
    accessToken,
    refreshToken:
      typeof rotated === "string" && rotated.length > 0
        ? rotated
        : refreshToken,
  };
}

/** `POST /auth/exchange_user_api_key`: trades a Cursor API key for a token pair. */
export async function exchangeApiKey(
  apiKey: string,
  endpoints: AuthEndpoints = {},
): Promise<TokenPair> {
  const response = await authFetch(
    endpoints,
    `${apiUrlOf(endpoints)}/auth/exchange_user_api_key`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: "{}",
    },
    "Exchanging the API key",
  );

  if (await isPolicyBlocked(response)) throw policyBlocked();
  if (!response.ok) {
    throw new GrokBotError(
      response.status >= 500 ? "http" : "auth",
      `The API key was not accepted (HTTP ${response.status}).`,
    );
  }
  const pair = parseTokenPair(await response.json().catch(() => null));
  if (!pair) {
    throw new GrokBotError(
      "protocol",
      "Exchanging the API key returned no token pair.",
    );
  }
  return pair;
}
