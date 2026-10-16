import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GrokBotError } from "./contracts.js";

/**
 * Who may read `grokbot login`'s Keychain item without a macOS dialog:
 * - "silent": any process of this macOS user (works for grokbot-mcp and background agents).
 * - "prompt": macOS asks before each process reads it (one dialog per grokbot run).
 */
export type KeychainAccess = "silent" | "prompt";
export const KEYCHAIN_ACCESS_MODES: readonly KeychainAccess[] = [
  "silent",
  "prompt",
];

/** Whether grokbot keeps its local usage log (usage-log.ts). Nothing leaves the machine either way. */
export type UsageSetting = "on" | "off";

/** grokbot's own settings. Never holds a token: secrets live only in the Keychain. */
export interface CliConfig {
  readonly keychainAccess: KeychainAccess;
  readonly usage: UsageSetting;
}

export const DEFAULT_CLI_CONFIG: CliConfig = {
  keychainAccess: "silent",
  usage: "on",
};

export const isUsageSetting = (value: unknown): value is UsageSetting =>
  value === "on" || value === "off";

export interface CliConfigStore {
  readonly path: string;
  read(): Promise<CliConfig>;
  write(config: CliConfig): Promise<void>;
}

export const isKeychainAccess = (value: unknown): value is KeychainAccess =>
  value === "silent" || value === "prompt";

/** `~/.grokbot/grokbot-cli.json`, beside the jobs folder the CLI already keeps. */
export function cliConfigStore(home: string = homedir()): CliConfigStore {
  const path = join(home, ".grokbot", "grokbot-cli.json");
  const invalid = (detail: string) =>
    new GrokBotError("auth", `${path}: ${detail}`);
  const badAccess = () =>
    invalid(
      'keychainAccess must be "silent" or "prompt". Fix it with grokbot config keychain-access <silent|prompt>.',
    );
  return {
    path,
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return DEFAULT_CLI_CONFIG;
        }
        throw new GrokBotError("auth", `Cannot read ${path}.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw badAccess();
      }
      const o =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { keychainAccess?: unknown; usage?: unknown })
          : {};
      const { keychainAccess = DEFAULT_CLI_CONFIG.keychainAccess } = o;
      const { usage = DEFAULT_CLI_CONFIG.usage } = o;
      if (!isKeychainAccess(keychainAccess)) throw badAccess();
      if (!isUsageSetting(usage))
        throw invalid(
          'usage must be "on" or "off". Fix it with grokbot config usage <on|off>.',
        );
      return { keychainAccess, usage };
    },
    async write(config) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // Write then rename, so a crash never leaves a half-written file behind.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temp, path);
    },
  };
}
