/**
 * What a posted inbox string must never contain: anything that looks like a credential.
 * Patterns are anchored on well-known prefixes and demand a long enough body, so commit
 * SHAs, UUIDs, item ids and ordinary words never match.
 */
const PATTERNS: readonly (readonly [label: string, pattern: RegExp])[] = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["API key (sk-)", /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/],
  ["live API key (sk_live_ or rk_live_)", /\b[sr]k_live_[A-Za-z0-9]{10,}/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/,
  ],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}/],
  [
    "bearer token",
    /\bBearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*/i,
  ],
];

/** The kind of credential `text` looks like, or undefined when it looks clean. */
export function credentialKind(text: string): string | undefined {
  for (const [label, pattern] of PATTERNS) if (pattern.test(text)) return label;
  return undefined;
}
