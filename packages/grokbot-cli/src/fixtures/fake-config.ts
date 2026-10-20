import type {
  KeychainAccess,
  ProjectRoute,
  ProtectedRole,
  UsageSetting,
} from "grokbot-core";
import type { ConfigDeps } from "../config-command.js";

/** In-memory settings, Keychain item and protected list for `grokbot config` tests. */
export function fakeConfig(
  initial: KeychainAccess = "silent",
  item: KeychainAccess | undefined = undefined,
  cwd?: string,
): ConfigDeps & {
  state: {
    access: KeychainAccess;
    usage: UsageSetting;
    item?: KeychainAccess;
    switched: KeychainAccess[];
    writes: number;
    bots: Map<string, ProtectedRole>;
    botWrites: number;
    routes: Map<string, ProjectRoute>;
    routeWrites: number;
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
    routes: new Map<string, ProjectRoute>(),
    routeWrites: 0,
  };
  return {
    state,
    path: "/home/me/.grokbot/grokbot-cli.json",
    protectedPath: "/home/me/.grokbot/grokbot-cli-protected-bots.json",
    routesPath: "/home/me/.grokbot/grokbot-cli-project-routes.json",
    cwd: cwd ?? "/nonexistent/fake-config-folder",
    readRoutes: async () => new Map(state.routes),
    writeRoutes: async (routes) => {
      state.routes = new Map(routes);
      state.routeWrites++;
    },
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
