import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * One sign-in attempt. `verifier` stays on this machine; only `challenge` and `uuid`
 * go into the browser URL, and `/auth/poll` needs `uuid` + `verifier` to release tokens.
 * Mirrors the GrokBot app (app.asar v0.70.2, `t1t` in electron-main/main-app.cjs).
 */
export interface PkcePair {
  readonly uuid: string;
  readonly verifier: string;
  readonly challenge: string;
}

interface PkceSources {
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUUID?: () => string;
}

const VERIFIER_BYTES = 32;

/** base64url without padding (RFC 7636 §4.1). */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A fresh S256 PKCE pair and request uuid. */
export function createPkcePair(sources: PkceSources = {}): PkcePair {
  const draw = sources.randomBytes ?? randomBytes;
  const verifier = base64url(draw(VERIFIER_BYTES));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { uuid: (sources.randomUUID ?? randomUUID)(), verifier, challenge };
}

/**
 * The browser URL that starts sign-in. The owner signs in on this page (email,
 * password, 2FA or OTP all live there); the CLI never sees those values.
 */
export function buildLoginUrl(
  pair: Pick<PkcePair, "challenge" | "uuid">,
  websiteUrl: string,
): string {
  const url = new URL("/loginDeepControl", websiteUrl);
  url.searchParams.set("challenge", pair.challenge);
  url.searchParams.set("uuid", pair.uuid);
  url.searchParams.set("mode", "login");
  url.searchParams.set("redirectTarget", "cli");
  return url.toString();
}
