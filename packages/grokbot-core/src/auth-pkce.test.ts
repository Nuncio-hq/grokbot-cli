import { describe, expect, it } from "vitest";
import { buildLoginUrl, createPkcePair } from "./auth-pkce.js";

// RFC 7636 Appendix B: the verifier and S256 challenge for these 32 octets.
const RFC_OCTETS = Uint8Array.from([
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
  22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
]);

describe("createPkcePair", () => {
  it("matches the RFC 7636 S256 test vector", () => {
    const pair = createPkcePair({
      randomBytes: () => RFC_OCTETS,
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    });
    expect(pair).toStrictEqual({
      uuid: "00000000-0000-4000-8000-000000000000",
      verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
  });

  it("draws 32 fresh random bytes and a fresh uuid per pair", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.uuid).not.toBe(b.uuid);
  });
});

describe("buildLoginUrl", () => {
  it("builds the app's loginDeepControl URL for the CLI redirect target", () => {
    const url = new URL(
      buildLoginUrl({ challenge: "CH", uuid: "U-1" }, "https://cursor.com"),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://cursor.com/loginDeepControl",
    );
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      challenge: "CH",
      uuid: "U-1",
      mode: "login",
      redirectTarget: "cli",
    });
  });

  it("never puts the verifier in the URL", () => {
    const pair = createPkcePair();
    expect(buildLoginUrl(pair, "https://cursor.com")).not.toContain(
      pair.verifier,
    );
  });
});
