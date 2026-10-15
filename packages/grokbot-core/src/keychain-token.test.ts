import { Buffer } from "node:buffer";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  decryptSafeStorageV10,
  readGrokBotAccessToken,
} from "./keychain-token.js";

const PASSWORD = "synthetic-keychain-password";

function encryptV10(plaintext: string, password: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
}

function secretsFile(active: string, tokens: Record<string, string>): string {
  const accounts = Object.fromEntries(
    Object.entries(tokens).map(([id, token]) => [
      id,
      {
        "cursor-access-token": encryptV10(token, PASSWORD).toString("base64"),
        "cursor-refresh-token": "unused",
      },
    ]),
  );
  return JSON.stringify({
    "cursor-accounts": JSON.stringify({ active, accounts }),
  });
}

describe("decryptSafeStorageV10", () => {
  it("decrypts a blob produced by openssl enc -aes-128-cbc", () => {
    const blob = Buffer.from(
      "djEwrnDXT7LFwVJC15CHueHkphaUCBg2NOfk8VK2ZT3TXfs=",
      "base64",
    );
    expect(decryptSafeStorageV10(blob, "kat-keychain-password")).toBe(
      "kat-synthetic-token.v10",
    );
  });

  it("decrypts a multi-block token", () => {
    const token = "header.synthetic-payload-that-spans-several-blocks.sig";
    expect(decryptSafeStorageV10(encryptV10(token, PASSWORD), PASSWORD)).toBe(
      token,
    );
  });

  it("rejects a blob without the v10 prefix", () => {
    const blob = encryptV10("synthetic", PASSWORD);
    blob.write("v11", 0);
    expect(() => decryptSafeStorageV10(blob, PASSWORD)).toThrow(
      new GrokBotError(
        "auth",
        "The Grok Bot token is not in safeStorage v10 format.",
      ),
    );
  });

  it("rejects the wrong Keychain password", () => {
    const blob = encryptV10("synthetic-token", PASSWORD);
    expect(() => decryptSafeStorageV10(blob, "wrong-password")).toThrow(
      new GrokBotError(
        "auth",
        "Cannot decrypt the Grok Bot token. Open the Grok Bot app once to refresh it.",
      ),
    );
  });
});

describe("readGrokBotAccessToken", () => {
  const keychain = async () => PASSWORD;

  it("decrypts the active account's access token", async () => {
    const token = await readGrokBotAccessToken({
      platform: "darwin",
      readSecretsFile: async () =>
        secretsFile("acct-2", {
          "acct-1": "synthetic-token-one",
          "acct-2": "synthetic-token-two",
        }),
      readKeychainPassword: keychain,
    });
    expect(token).toBe("synthetic-token-two");
  });

  it("reads the file fresh on every call", async () => {
    const files = [
      secretsFile("a", { a: "synthetic-first" }),
      secretsFile("a", { a: "synthetic-second" }),
    ];
    const deps = {
      platform: "darwin",
      readSecretsFile: async () => files.shift() ?? "",
      readKeychainPassword: keychain,
    };
    expect([
      await readGrokBotAccessToken(deps),
      await readGrokBotAccessToken(deps),
    ]).toEqual(["synthetic-first", "synthetic-second"]);
  });

  it("explains that auth needs macOS", async () => {
    await expect(readGrokBotAccessToken({ platform: "linux" })).rejects.toEqual(
      new GrokBotError(
        "auth",
        "GrokBot auth needs macOS with the Grok Bot app installed and logged in.",
      ),
    );
  });

  it("explains a missing Grok Bot app", async () => {
    await expect(
      readGrokBotAccessToken({
        platform: "darwin",
        readSecretsFile: async () => {
          throw Object.assign(new Error("ENOENT: no such file"), {
            code: "ENOENT",
          });
        },
        readKeychainPassword: keychain,
      }),
    ).rejects.toEqual(
      new GrokBotError(
        "auth",
        "Cannot read the Grok Bot account file. Install the Grok Bot app and log in once.",
      ),
    );
  });

  it("keeps file contents out of the shape error", async () => {
    const error = await readGrokBotAccessToken({
      platform: "darwin",
      readSecretsFile: async () =>
        JSON.stringify({ "cursor-accounts": "SECRET-CONTENT{" }),
      readKeychainPassword: keychain,
    }).catch((caught: unknown) => caught);
    expect(error).toEqual(
      new GrokBotError(
        "auth",
        "The Grok Bot account file has an unexpected shape. Open the Grok Bot app and log in again.",
      ),
    );
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects an active account that is not in the file", async () => {
    await expect(
      readGrokBotAccessToken({
        platform: "darwin",
        readSecretsFile: async () => secretsFile("gone", { a: "synthetic" }),
        readKeychainPassword: keychain,
      }),
    ).rejects.toEqual(
      new GrokBotError(
        "auth",
        "The Grok Bot account file has an unexpected shape. Open the Grok Bot app and log in again.",
      ),
    );
  });

  it("explains a Keychain failure", async () => {
    await expect(
      readGrokBotAccessToken({
        platform: "darwin",
        readSecretsFile: async () => secretsFile("a", { a: "synthetic" }),
        readKeychainPassword: async () => {
          throw new Error("security: exit 44");
        },
      }),
    ).rejects.toEqual(
      new GrokBotError(
        "auth",
        'Cannot read the "Grok Bot Safe Storage" Keychain item. Open the Grok Bot app once and allow Keychain access.',
      ),
    );
  });
});
