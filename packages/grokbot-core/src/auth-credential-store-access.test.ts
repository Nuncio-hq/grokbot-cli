import { describe, expect, it } from "vitest";
import { credentialStore } from "./auth-credential-store.js";
import type { KeychainRunner } from "./auth-security-runner.js";
import { GrokBotError } from "./contracts.js";

const PAIR = { accessToken: "acc.tok.sig", refreshToken: "ref.tok.sig" };
const NEXT = { accessToken: "acc.new.sig", refreshToken: "ref.new.sig" };

interface Item {
  value: string;
  comment?: string;
  /** undefined = trusts /usr/bin/security (silent); "" = no trusted app (prompt). */
  trusted?: string;
}

/**
 * A fake `security` that models what the real one did on a temp keychain:
 * `-U` keeps the existing ACL and comment unless given; `-T ""` makes reads ask;
 * attribute reads (no -w) never ask; a prompt read waits for the owner.
 */
function fakeKeychain(initial?: Item, owner: "allow" | "deny" = "allow") {
  let item: Item | undefined = initial;
  const calls: {
    args: readonly string[];
    stdin?: string;
    timeoutMs?: number;
  }[] = [];
  let failNextAdd = false;
  const run: KeychainRunner = async (args, stdin, options) => {
    calls.push({
      args,
      ...(stdin && { stdin }),
      ...(options?.timeoutMs && { timeoutMs: options.timeoutMs }),
    });
    const [verb] = args;
    if (verb === "-i") {
      if (failNextAdd) {
        failNextAdd = false;
        return { code: 1, stdout: "" };
      }
      const line = stdin ?? "";
      const value = /-w (\S+)\n$/.exec(line)?.[1] ?? "";
      const comment = / -j (\S+)/.exec(line)?.[1];
      const trusted = line.includes(' -T "" ') ? "" : undefined;
      item =
        item && line.includes(" -U ")
          ? { ...item, value }
          : {
              value,
              ...(comment && { comment }),
              ...(trusted !== undefined && { trusted }),
            };
      return { code: 0, stdout: "" };
    }
    if (verb === "find-generic-password") {
      if (!item) return { code: 44, stdout: "" };
      if (!args.includes("-w")) {
        return {
          code: 0,
          stdout: item.comment ? `    "icmt"<blob>="${item.comment}"\n` : "",
        };
      }
      if (item.trusted === "" && owner === "deny")
        return { code: 51, stdout: "" };
      return { code: 0, stdout: `${item.value}\n` };
    }
    if (verb === "delete-generic-password") {
      const had = item !== undefined;
      item = undefined;
      return { code: had ? 0 : 44, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return {
    run,
    calls,
    get item() {
      return item;
    },
    failNextAdd() {
      failNextAdd = true;
    },
    reads: () =>
      calls.filter(
        (c) => c.args[0] === "find-generic-password" && c.args.includes("-w"),
      ),
  };
}

const store = (
  kc: ReturnType<typeof fakeKeychain>,
  access: "silent" | "prompt",
) =>
  credentialStore({
    run: kc.run,
    access: async () => access,
    platform: "darwin",
  });

describe("credentialStore access modes", () => {
  it("silent (default): creates an item every process of this user can read", async () => {
    const kc = fakeKeychain();
    await store(kc, "silent").save(PAIR);
    expect(kc.item?.trusted).toBeUndefined();
    expect(kc.item?.comment).toBe("grokbot-cli-access=silent");
  });

  it("prompt: creates an item with no trusted app, so macOS asks before each read", async () => {
    const kc = fakeKeychain();
    await store(kc, "prompt").save(PAIR);
    expect(kc.item?.trusted).toBe("");
    expect(kc.item?.comment).toBe("grokbot-cli-access=prompt");
    const write = kc.calls.find((c) => c.args[0] === "-i");
    expect(write?.stdin).toContain(' -T "" ');
  });

  it("a refresh save keeps the item's mode instead of resetting it", async () => {
    const kc = fakeKeychain();
    const s = store(kc, "prompt");
    await s.save(PAIR);
    await s.save(NEXT);
    expect(kc.item).toMatchObject({
      trusted: "",
      comment: "grokbot-cli-access=prompt",
    });
    expect(await s.load()).toStrictEqual(NEXT);
  });

  it("prompt: reads the Keychain once per process (one dialog), then serves from memory", async () => {
    const kc = fakeKeychain();
    await store(kc, "prompt").save(PAIR);
    const s = store(kc, "prompt");
    expect(await s.load()).toStrictEqual(PAIR);
    expect(await s.load()).toStrictEqual(PAIR);
    expect(kc.reads()).toHaveLength(1);
    expect(kc.reads()[0]?.timeoutMs).toBe(60_000);
  });

  it("silent: reads the Keychain fresh on every call (Rule 2)", async () => {
    const kc = fakeKeychain();
    const s = store(kc, "silent");
    await s.save(PAIR);
    await s.load();
    await s.load();
    expect(kc.reads()).toHaveLength(2);
  });

  it("prompt: explains a denied or timed-out dialog instead of falling back to another account", async () => {
    const kc = fakeKeychain(undefined, "deny");
    await store(kc, "prompt").save(PAIR);
    await expect(store(kc, "prompt").load()).rejects.toEqual(
      new GrokBotError(
        "auth",
        'macOS did not allow reading the grokbot sign-in (keychain access is "prompt"; security exited 51). Click Allow on the dialog, or run grokbot config keychain-access silent.',
      ),
    );
  });

  it("reports which mode the saved item really has, without reading the token", async () => {
    const kc = fakeKeychain();
    const s = store(kc, "prompt");
    expect(await s.itemAccess()).toBeUndefined();
    await s.save(PAIR);
    expect(await s.itemAccess()).toBe("prompt");
    expect(kc.reads()).toHaveLength(0);
  });
});

describe("credentialStore.setAccess (switching mode)", () => {
  it("re-creates the saved item with the new mode, keeping the sign-in", async () => {
    const kc = fakeKeychain();
    await store(kc, "silent").save(PAIR);
    const result = await store(kc, "silent").setAccess("prompt");
    expect(result).toStrictEqual({ migrated: true });
    expect(kc.item).toMatchObject({
      trusted: "",
      comment: "grokbot-cli-access=prompt",
    });
    expect(await store(kc, "prompt").load()).toStrictEqual(PAIR);
  });

  it("does nothing to the Keychain when no sign-in is saved", async () => {
    const kc = fakeKeychain();
    expect(await store(kc, "silent").setAccess("prompt")).toStrictEqual({
      migrated: false,
    });
    expect(
      kc.calls.filter((c) => c.args[0] !== "find-generic-password"),
    ).toStrictEqual([]);
  });

  it("puts the old item back if re-creating it fails, so the sign-in is never lost", async () => {
    const kc = fakeKeychain();
    await store(kc, "silent").save(PAIR);
    kc.failNextAdd();
    await expect(store(kc, "silent").setAccess("prompt")).rejects.toEqual(
      new GrokBotError(
        "auth",
        "Cannot switch the grokbot sign-in to prompt access (security exited 1); the previous item was kept.",
      ),
    );
    expect(kc.item?.comment).toBe("grokbot-cli-access=silent");
    expect(await store(kc, "silent").load()).toStrictEqual(PAIR);
  });

  it("never puts the token on argv while switching", async () => {
    const kc = fakeKeychain();
    await store(kc, "silent").save(PAIR);
    await store(kc, "silent").setAccess("prompt");
    const argv = kc.calls.flatMap((c) => c.args).join(" ");
    expect(argv).not.toContain("acc.tok.sig");
  });
});
