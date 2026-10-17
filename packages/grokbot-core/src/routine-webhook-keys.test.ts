import { describe, expect, it } from "vitest";
import type { KeychainRunner } from "./auth-security-runner.js";
import { GrokBotError } from "./contracts.js";
import {
  WEBHOOK_KEY_SERVICE,
  webhookKeyStore,
} from "./routine-webhook-keys.js";

const KEY = "synthetic-webhook-key-91c2";
const REF = { agentId: "agent-1", automationId: "auto-1", createdAt: 1000 };

/** An in-memory `security` binary for one item: records argv and stdin. */
function fakeKeychain() {
  let item: string | undefined;
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  const run: KeychainRunner = async (args, stdin) => {
    calls.push({ args, ...(stdin !== undefined && { stdin }) });
    if (args[0] === "-i") {
      item = /-w (\S+)\n$/.exec(stdin ?? "")?.[1];
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
  return { run, calls };
}

const store = (run: KeychainRunner, platform = "darwin") =>
  webhookKeyStore({ run, platform, access: async () => "silent" });

describe("webhookKeyStore", () => {
  it("keeps the key on stdin only, under a hashed per-routine account", async () => {
    const keychain = fakeKeychain();
    const keys = store(keychain.run);
    await keys.save(REF, KEY);
    const item = keys.item(REF);
    expect(item.service).toBe(WEBHOOK_KEY_SERVICE);
    expect(item.account).toMatch(/^[0-9a-f]{64}$/);
    expect(keychain.calls.some((c) => c.args.join(" ").includes(KEY))).toBe(
      false,
    );
    const write = keychain.calls.find((c) => c.args[0] === "-i");
    expect(write?.stdin).toMatch(
      new RegExp(
        `^add-generic-password -U -a ${item.account} -s ${WEBHOOK_KEY_SERVICE} -j grokbot-cli-access=silent -w \\S+\\n$`,
      ),
    );
    expect(write?.stdin).not.toContain(KEY);
    expect(await keys.load(REF)).toBe(KEY);
  });

  it("ignores a key stored for an earlier routine with the same ids", async () => {
    const keychain = fakeKeychain();
    const keys = store(keychain.run);
    await keys.save(REF, KEY);
    expect(await keys.load({ ...REF, createdAt: 2000 })).toBeUndefined();
  });

  it("gives a different item to each routine", () => {
    const keys = store(fakeKeychain().run);
    expect(keys.item(REF).account).not.toBe(
      keys.item({ ...REF, automationId: "auto-2" }).account,
    );
  });

  it("removes the item once and reports whether it was there", async () => {
    const keychain = fakeKeychain();
    const keys = store(keychain.run);
    await keys.save(REF, KEY);
    expect([await keys.remove(REF), await keys.remove(REF)]).toEqual([
      true,
      false,
    ]);
  });

  it("needs macOS to load or save, and removes nothing elsewhere", async () => {
    const keys = store(fakeKeychain().run, "linux");
    const error = await keys.load(REF).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).toContain("macOS Keychain");
    expect(await keys.remove(REF)).toBe(false);
  });

  it("fails on a locked keychain instead of reporting no key", async () => {
    const keys = store(async () => ({ code: 36, stdout: "" }));
    expect(
      await keys.load(REF).catch((e: unknown) => (e as Error).message),
    ).toContain("security exited 36");
  });
});
