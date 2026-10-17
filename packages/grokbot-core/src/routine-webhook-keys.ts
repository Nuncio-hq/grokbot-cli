import { createHash } from "node:crypto";
import {
  type KeychainRunner,
  runSecurity,
  SECURITY_NOT_FOUND,
  SECURITY_PROMPT_TIMEOUT_MS,
} from "./auth-security-runner.js";
import { cliConfigStore, type KeychainAccess } from "./cli-config.js";
import { GrokBotError } from "./contracts.js";
import {
  addItemLine,
  itemAccessOf,
  type KeychainItem,
} from "./keychain-items.js";
import { BACKEND_URL } from "./server-transport.js";

/** Keychain service of the routine webhook keys grokbot mints: one item per routine. */
export const WEBHOOK_KEY_SERVICE = "grokbot-cli-webhook";

/** Which routine a key starts. `createdAt` tells a re-created routine with the same ids apart. */
export interface WebhookKeyRef {
  readonly agentId: string;
  readonly automationId: string;
  readonly createdAt: number | null;
}

/** Webhook keys in the macOS Keychain, never in a file. No method returns a key except `load`. */
export interface WebhookKeyStore {
  /** The item that holds, or would hold, the routine's key. Carries no secret. */
  item(ref: WebhookKeyRef): KeychainItem;
  /** The key, only if one is stored for this very routine (same createdAt). */
  load(ref: WebhookKeyRef): Promise<string | undefined>;
  save(ref: WebhookKeyRef, key: string): Promise<void>;
  /** True when an item was removed. */
  remove(ref: WebhookKeyRef): Promise<boolean>;
}

export interface WebhookKeyStoreOptions {
  readonly platform?: string;
  readonly run?: KeychainRunner;
  /** The configured mode for new items. Default: ~/.grokbot/grokbot-cli.json. */
  readonly access?: () => Promise<KeychainAccess>;
}

interface StoredKey {
  readonly version: 1;
  readonly createdAt: number | null;
  readonly key: string;
}

export function webhookKeyStore(
  options: WebhookKeyStoreOptions = {},
): WebhookKeyStore {
  const {
    platform = process.platform,
    run = runSecurity,
    access = async () => (await cliConfigStore().read()).keychainAccess,
  } = options;
  const onMac = platform === "darwin";
  const requireMac = () => {
    if (!onMac) {
      throw new GrokBotError(
        "auth",
        "Routine webhook keys live in the macOS Keychain, so this needs macOS.",
      );
    }
  };
  const item = (ref: WebhookKeyRef): KeychainItem => ({
    service: WEBHOOK_KEY_SERVICE,
    account: createHash("sha256")
      .update(JSON.stringify([BACKEND_URL, ref.agentId, ref.automationId]))
      .digest("hex"),
  });
  const args = ({ account, service }: KeychainItem) => [
    "-a",
    account,
    "-s",
    service,
  ];
  /** The stored item's access mode, from its attributes (never a dialog); undefined if none. */
  const accessOf = async (target: KeychainItem) => {
    const { code, stdout } = await run([
      "find-generic-password",
      ...args(target),
    ]);
    if (code === 0) return itemAccessOf(stdout);
    if (code === SECURITY_NOT_FOUND) return undefined;
    throw new GrokBotError(
      "auth",
      `Cannot read the Keychain (security exited ${code}). Unlock the login keychain and retry.`,
    );
  };

  return {
    item,

    async load(ref) {
      requireMac();
      const target = item(ref);
      const mode = await accessOf(target);
      if (mode === undefined) return undefined;
      const { code, stdout } = await run(
        ["find-generic-password", ...args(target), "-w"],
        undefined,
        mode === "prompt"
          ? { timeoutMs: SECURITY_PROMPT_TIMEOUT_MS }
          : undefined,
      );
      if (code !== 0) {
        throw new GrokBotError(
          "auth",
          `macOS did not allow reading the routine's webhook key (security exited ${code}).${mode === "prompt" ? " Click Allow on the dialog." : ""}`,
        );
      }
      const stored = decode(stdout.trim());
      return stored?.createdAt === ref.createdAt ? stored.key : undefined;
    },

    async save(ref, key) {
      requireMac();
      const target = item(ref);
      // A brand-new item takes the configured mode; an existing one keeps its own (-U).
      const mode = (await accessOf(target)) ?? (await access());
      const stored: StoredKey = { version: 1, createdAt: ref.createdAt, key };
      const line = addItemLine(target, encode(stored), mode, true);
      if (line === undefined) {
        throw new GrokBotError(
          "protocol",
          "The webhook key is too large for the Keychain helper; nothing was saved.",
        );
      }
      const { code } = await run(["-i"], line);
      if (code !== 0) {
        throw new GrokBotError(
          "auth",
          `Cannot save the webhook key to the Keychain (security exited ${code}).`,
        );
      }
    },

    async remove(ref) {
      if (!onMac) return false;
      const { code } = await run([
        "delete-generic-password",
        ...args(item(ref)),
      ]);
      if (code === 0) return true;
      if (code === SECURITY_NOT_FOUND) return false;
      throw new GrokBotError(
        "auth",
        `Cannot remove the webhook key from the Keychain (security exited ${code}).`,
      );
    },
  };
}

/** base64url(JSON): no spaces or quotes, so the `security -i` line parses unambiguously. */
function encode(stored: StoredKey): string {
  return Buffer.from(JSON.stringify(stored), "utf8").toString("base64url");
}

function decode(value: string): StoredKey | undefined {
  try {
    const raw: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (typeof raw !== "object" || raw === null) return undefined;
    const { version, createdAt, key } = raw as Record<string, unknown>;
    if (version !== 1 || typeof key !== "string" || key === "") {
      return undefined;
    }
    if (createdAt !== null && typeof createdAt !== "number") return undefined;
    return { version, createdAt, key };
  } catch {
    return undefined;
  }
}
