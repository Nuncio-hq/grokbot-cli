import type { KeychainAccess, ProtectedRole, UsageSetting } from "grokbot-core";
import type { ConfigDeps } from "../config-command.js";

/** In-memory settings, Keychain item and protected list for `grokbot config` tests. */
export function fakeConfig(
  initial: KeychainAccess = "silent",
  item: KeychainAccess | undefined = undefined,
): ConfigDeps & {
  state: {
    access: KeychainAccess;
    usage: UsageSetting;
    item?: KeychainAccess;
    switched: KeychainAccess[];
    writes: number;
    bots: Map<string, ProtectedRole>;
    botWrites: number;
  };
} {
  const state = {
    access: initial,
    usage: "on" as UsageSetting,
    item,
    switched: [] as KeychainAccess[],
    writes: 0,
    bots: new Map<string, ProtectedRole>(),
    botWrites: 0,
  };
  return {
    state,
    path: "/home/me/.grokbot/grokbot-cli.json",
    protectedPath: "/home/me/.grokbot/grokbot-cli-protected-bots.json",
    readProtected: async () => new Map(state.bots),
    writeProtected: async (bots) => {
      state.bots = new Map(bots);
      state.botWrites++;
    },
    read: async () => ({ keychainAccess: state.access, usage: state.usage }),
    write: async (config) => {
      state.access = config.keychainAccess;
      state.usage = config.usage;
      state.writes++;
    },
    itemAccess: async () => state.item,
    setItemAccess: async (next) => {
      if (state.item === undefined) return { migrated: false };
      state.item = next;
      state.switched.push(next);
      return { migrated: true };
    },
  };
}
