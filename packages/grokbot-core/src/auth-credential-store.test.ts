import { describe, expect, it } from "vitest";
import {
  type CredentialStoreOptions,
  credentialStore,
  type KeychainRunner,
} from "./auth-credential-store.js";
import { GrokBotError } from "./contracts.js";

const PAIR = { accessToken: "acc.tok.sig", refreshToken: "ref.tok.sig" };
const SERVICE = "grokbot-cli";

/** Pins the platform and mode, so tests never read ~/.grokbot or depend on the host OS. */
const opts = (run: KeychainRunner): CredentialStoreOptions => ({
  run,
  platform: "darwin",
  access: async () => "silent",
});

/** An in-memory `security` binary: records argv and stdin, never touches the Keychain. */
function fakeKeychain(initial?: string) {
  let item = initial;
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  const run: KeychainRunner = async (args, stdin) => {
    calls.push({ args, ...(stdin !== undefined && { stdin }) });
    if (args[0] === "-i") {
      const match = /-w (\S+)\n$/.exec(stdin ?? "");
      item = match?.[1];
      return { code: 0, stdout: "" };
    }
    if (args[0] === "find-generic-password") {
      if (item === undefined) return { code: 44, stdout: "" };
      return { code: 0, stdout: args.includes("-w") ? `${item}\n` : "" };
    }
    if (args[0] === "delete-generic-password") {
      const had = item !== undefined;
      item = undefined;
      return { code: had ? 0 : 44, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return {
    run,
    calls,
    writes: () => calls.filter((c) => c.args[0] === "-i"),
    get item() {
      return item;
    },
  };
}

describe("credentialStore", () => {
  it("returns undefined when nothing is saved", async () => {
    const kc = fakeKeychain();
    expect(await credentialStore(opts(kc.run)).load()).toBeUndefined();
  });

  it("saves a pair and loads it back", async () => {
    const kc = fakeKeychain();
    const store = credentialStore(opts(kc.run));
    await store.save(PAIR);
    expect(await store.load()).toStrictEqual(PAIR);
  });

  it("never puts the token on the security argv", async () => {
    const kc = fakeKeychain();
    await credentialStore(opts(kc.run)).save(PAIR);
    const argv = kc.calls.flatMap((c) => c.args).join(" ");
    expect(argv).not.toContain(PAIR.accessToken);
    expect(argv).not.toContain(PAIR.refreshToken);
    expect(kc.writes()).toHaveLength(1);
    expect(kc.writes()[0]?.args).toStrictEqual(["-i"]);
  });

  it("writes one -U item under its own service, separate from the app's", async () => {
    const kc = fakeKeychain();
    await credentialStore(opts(kc.run)).save(PAIR);
    const stdin = kc.writes()[0]?.stdin ?? "";
    expect(stdin.startsWith("add-generic-password -U -a ")).toBe(true);
    expect(stdin).toContain(` -s ${SERVICE} `);
    expect(stdin).not.toContain("Grok Bot Safe Storage");
  });

  it("stores the value as base64url so stdin parsing is unambiguous", async () => {
    const kc = fakeKeychain();
    await credentialStore(opts(kc.run)).save(PAIR);
    expect(kc.item).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("clears the saved pair and reports whether one existed", async () => {
    const kc = fakeKeychain();
    const store = credentialStore(opts(kc.run));
    await store.save(PAIR);
    expect(await store.clear()).toBe(true);
    expect(await store.load()).toBeUndefined();
    expect(await store.clear()).toBe(false);
  });

  it("reports a locked or unreadable Keychain instead of pretending nobody signed in", async () => {
    // The attribute lookup finds the item; reading its value fails (locked keychain).
    const run: KeychainRunner = async (args) =>
      args.includes("-w") ? { code: 51, stdout: "" } : { code: 0, stdout: "" };
    await expect(credentialStore(opts(run)).load()).rejects.toEqual(
      new GrokBotError(
        "auth",
        "Cannot read the grokbot sign-in from the Keychain (security exited 51). Unlock the login keychain and retry.",
      ),
    );
  });

  it("treats a missing security binary as no sign-in, so app-only users see no change", async () => {
    const run: KeychainRunner = async () => ({ code: 127, stdout: "" });
    expect(await credentialStore(opts(run)).load()).toBeUndefined();
  });

  it("refuses a pair too long for one security -i line, writing nothing", async () => {
    const kc = fakeKeychain();
    const huge = {
      accessToken: "a".repeat(3000),
      refreshToken: "r".repeat(100),
    };
    await expect(credentialStore(opts(kc.run)).save(huge)).rejects.toEqual(
      new GrokBotError(
        "auth",
        "The GrokBot sign-in is too large for the Keychain helper; nothing was saved.",
      ),
    );
    expect(kc.writes()).toStrictEqual([]);
  });

  it("treats a corrupt item as absent instead of crashing", async () => {
    const kc = fakeKeychain("not-base64-json!!");
    expect(await credentialStore(opts(kc.run)).load()).toBeUndefined();
  });

  it("fails loudly with no token in the message when a write fails", async () => {
    const run: KeychainRunner = async (args) =>
      args[0] === "-i" ? { code: 1, stdout: "" } : { code: 44, stdout: "" };
    await expect(credentialStore(opts(run)).save(PAIR)).rejects.toEqual(
      new GrokBotError(
        "auth",
        "Cannot save the GrokBot sign-in to the Keychain (security exited 1).",
      ),
    );
  });

  it("refuses to run off macOS", async () => {
    await expect(
      credentialStore({ platform: "linux" }).save(PAIR),
    ).rejects.toEqual(
      new GrokBotError(
        "auth",
        "grokbot login stores its sign-in in the macOS Keychain, so it needs macOS.",
      ),
    );
  });
});
