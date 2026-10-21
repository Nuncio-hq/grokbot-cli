import { GrokBotError, type SignInInfo } from "grokbot-core";
import { describe, expect, it } from "vitest";
import type { AuthDeps } from "./auth-command.js";
import { runCli } from "./fixtures/run-cli.js";

const URL_ =
  "https://cursor.com/loginDeepControl?challenge=C&uuid=U&mode=login&redirectTarget=cli";

interface Recorded {
  browser: { openBrowser: boolean }[];
  apiKeys: string[];
  cleared: number;
}

function fakeAuth(
  overrides: Partial<AuthDeps> = {},
): AuthDeps & { rec: Recorded } {
  const rec: Recorded = { browser: [], apiKeys: [], cleared: 0 };
  return {
    rec,
    loginWithBrowser: async (options) => {
      rec.browser.push({ openBrowser: options.openBrowser !== false });
      options.showUrl(URL_);
      return { method: "browser" };
    },
    loginWithApiKey: async (key) => {
      rec.apiKeys.push(key);
      return { method: "api-key" };
    },
    clear: async () => {
      rec.cleared++;
      return true;
    },
    describe: async (): Promise<SignInInfo> => ({
      source: "cli",
      expiresAt: Date.UTC(2026, 11, 12),
    }),
    appVersions: async () => ({ installed: "0.72.0", catalog: "0.72.0" }),
    openUrl: async () => {},
    readStdin: async () => "",
    renderQr: () => "[QR]\n",
    ...overrides,
  };
}

describe("grokbot login (browser)", () => {
  it("prints the sign-in URL and a QR, opens the browser, and reports success", async () => {
    const auth = fakeAuth();
    const run = await runCli(["login"], { auth, isTTY: true });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(URL_);
    expect(run.stderr).toContain("[QR]");
    expect(run.stderr).toContain("Finish signing in");
    expect(run.stdout).toContain("Signed in");
    expect(run.stdout).toContain("Keychain");
    expect(auth.rec.browser).toStrictEqual([{ openBrowser: true }]);
  });

  it("never builds the RPC runner", async () => {
    const run = await runCli(["login"], { auth: fakeAuth() });
    expect(run.runnerOptions).toStrictEqual([]);
  });

  it("--no-browser only shows the URL, for a remote or headless machine", async () => {
    const auth = fakeAuth();
    const run = await runCli(["login", "--no-browser"], { auth });
    expect(run.code).toBe(0);
    expect(auth.rec.browser).toStrictEqual([{ openBrowser: false }]);
  });

  it("skips the QR when stderr is not a terminal", async () => {
    const run = await runCli(["login"], { auth: fakeAuth(), isTTY: false });
    expect(run.stderr).toContain(URL_);
    expect(run.stderr).not.toContain("[QR]");
  });

  it("--json prints one document on stdout", async () => {
    const run = await runCli(["login", "--json"], { auth: fakeAuth() });
    expect(JSON.parse(run.stdout)).toStrictEqual({
      signedIn: true,
      method: "browser",
    });
  });

  it("maps a failed sign-in to exit 1 with the core message", async () => {
    const auth = fakeAuth({
      loginWithBrowser: async () => {
        throw new GrokBotError(
          "timeout",
          "Sign-in was not completed in the browser in time. Run grokbot login again.",
        );
      },
    });
    const run = await runCli(["login"], { auth });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "grokbot: Sign-in was not completed in the browser in time. Run grokbot login again.\n",
    );
  });

  it("exits 130 on Ctrl-C while waiting for the browser", async () => {
    const interrupt = new AbortController();
    const auth = fakeAuth({
      loginWithBrowser: (options) =>
        new Promise((_, reject) => {
          options.showUrl(URL_);
          options.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          );
          interrupt.abort();
        }),
    });
    const run = await runCli(["login"], { auth, signal: interrupt.signal });
    expect(run.code).toBe(130);
    expect(run.stderr).toContain("grokbot: interrupted\n");
  });

  it("rejects an unknown flag as a usage error", async () => {
    const run = await runCli(["login", "--emial", "x"], { auth: fakeAuth() });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('grokbot: login: unknown flag "--emial"');
  });
});

describe("grokbot login --api-key (CI)", () => {
  it("reads the key from GROKBOT_API_KEY, never from argv", async () => {
    const auth = fakeAuth();
    const run = await runCli(["login", "--api-key"], {
      auth,
      env: { GROKBOT_API_KEY: "key_env" },
    });
    expect(run.code).toBe(0);
    expect(auth.rec.apiKeys).toStrictEqual(["key_env"]);
    expect(run.stdout + run.stderr).not.toContain("key_env");
  });

  it("falls back to stdin when the env var is unset", async () => {
    const auth = fakeAuth({ readStdin: async () => "key_stdin\n" });
    const run = await runCli(["login", "--api-key"], { auth });
    expect(run.code).toBe(0);
    expect(auth.rec.apiKeys).toStrictEqual(["key_stdin"]);
  });

  it("refuses a key passed as a value, so it never lands in shell history", async () => {
    const auth = fakeAuth();
    const run = await runCli(["login", "--api-key", "key_argv"], { auth });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--api-key takes no value");
    expect(run.stderr).not.toContain("key_argv");
    expect(auth.rec.apiKeys).toStrictEqual([]);
  });

  it("refuses --api-key=VALUE without echoing the key", async () => {
    const auth = fakeAuth();
    const run = await runCli(["login", "--api-key=key_inline"], { auth });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--api-key takes no value");
    expect(run.stdout + run.stderr).not.toContain("key_inline");
    expect(auth.rec.apiKeys).toStrictEqual([]);
  });

  it("never echoes the value of any unknown --flag=value", async () => {
    const run = await runCli(["whoami", "--token=secret_value"], {
      auth: fakeAuth(),
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown flag "--token"');
    expect(run.stderr).not.toContain("secret_value");
  });

  it("explains how to pass the key when none is given", async () => {
    const run = await runCli(["login", "--api-key"], { auth: fakeAuth() });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      "set GROKBOT_API_KEY or pipe the key on stdin",
    );
  });
});

describe("grokbot logout", () => {
  it("removes the CLI sign-in and leaves the app's login alone", async () => {
    const auth = fakeAuth();
    const run = await runCli(["logout"], { auth });
    expect(run.code).toBe(0);
    expect(auth.rec.cleared).toBe(1);
    expect(run.stdout).toBe(
      "Signed out of grokbot. The Grok Bot app's own login is unchanged.\n",
    );
  });

  it("says so when there was nothing to remove", async () => {
    const run = await runCli(["logout"], {
      auth: fakeAuth({ clear: async () => false }),
    });
    expect(run.stdout).toBe("grokbot had no saved sign-in.\n");
  });
});

describe("grokbot whoami", () => {
  it("names the CLI sign-in and its expiry, never the token", async () => {
    const run = await runCli(["whoami"], { auth: fakeAuth() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      "Using grokbot's own sign-in (macOS Keychain), valid until 2026-12-12T00:00:00.000Z.\n",
    );
  });

  it("names the Keychain access mode when known", async () => {
    const run = await runCli(["whoami"], {
      auth: fakeAuth({
        describe: async () => ({ source: "cli", keychainAccess: "prompt" }),
      }),
    });
    expect(run.stdout).toContain(
      "Using grokbot's own sign-in (macOS Keychain, prompt access).\n",
    );
  });

  it("names the app's token when the CLI has no sign-in", async () => {
    const run = await runCli(["whoami"], {
      auth: fakeAuth({ describe: async () => ({ source: "app" }) }),
    });
    expect(run.stdout).toContain("Using the Grok Bot desktop app's login.\n");
  });

  it("exits 1 when nothing is signed in", async () => {
    const run = await runCli(["whoami", "--json"], {
      auth: fakeAuth({ describe: async () => ({ source: "none" }) }),
    });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ source: "none" });
    expect(run.stderr).toBe("Not signed in. Run grokbot login.\n");
  });

  describe("proxy", () => {
    const proxied = (env: Record<string, string>, json = false) =>
      runCli(["whoami", ...(json ? ["--json"] : [])], {
        auth: fakeAuth(),
        env,
      });

    it("prints no proxy line and null JSON when none is configured", async () => {
      const text = await proxied({});
      expect(text.stdout).not.toContain("Proxy:");
      expect(JSON.parse((await proxied({}, true)).stdout).proxy).toBeNull();
    });

    it("names the proxy and where it came from, never its credentials", async () => {
      const env = { HTTPS_PROXY: "http://user:hunter2@proxy.example:3128" };
      const text = await proxied(env);
      expect(text.stdout).toContain(
        "Proxy: http://proxy.example:3128 (from HTTPS_PROXY)\n",
      );
      const json = await proxied(env, true);
      expect(JSON.parse(json.stdout).proxy).toEqual({
        url: "http://proxy.example:3128",
        source: "HTTPS_PROXY",
      });
      expect(text.stdout + json.stdout + text.stderr).not.toMatch(
        /user|hunter2/,
      );
    });

    it("prefers GROKBOT_HTTPS_PROXY, and shows nothing when it is off or the backend is exempt", async () => {
      const both = await proxied(
        {
          GROKBOT_HTTPS_PROXY: "http://own.example:1",
          HTTPS_PROXY: "http://std.example:2",
        },
        true,
      );
      expect(JSON.parse(both.stdout).proxy).toEqual({
        url: "http://own.example:1",
        source: "GROKBOT_HTTPS_PROXY",
      });
      const off = await proxied(
        { GROKBOT_HTTPS_PROXY: "off", HTTPS_PROXY: "http://std.example:2" },
        true,
      );
      expect(JSON.parse(off.stdout).proxy).toBeNull();
      const exempt = await proxied(
        { HTTPS_PROXY: "http://std.example:2", NO_PROXY: "cursor.sh" },
        true,
      );
      expect(JSON.parse(exempt.stdout).proxy).toBeNull();
    });
  });

  describe("Grok Bot app version", () => {
    const versions = (installed: string | undefined, catalog = "0.72.0") =>
      fakeAuth({ appVersions: async () => ({ installed, catalog }) });

    it.each([
      ["newer", "0.73.0", true],
      ["the same", "0.72.0", false],
      ["older", "0.71.2", false],
    ])(
      "warns only when the installed app is newer (%s)",
      async (_, installed, warns) => {
        const run = await runCli(["whoami"], { auth: versions(installed) });
        expect(run.code).toBe(0);
        expect(run.stdout).toContain(installed);
        expect(run.stdout).toContain("0.72.0");
        expect(/warning/i.test(run.stdout)).toBe(warns);
        expect(run.stderr).toBe("");
      },
    );

    it("reports installed, catalog and newer in --json", async () => {
      const run = await runCli(["whoami", "--json"], {
        auth: versions("0.73.0"),
      });
      expect(JSON.parse(run.stdout).app).toStrictEqual({
        installed: "0.73.0",
        catalog: "0.72.0",
        newer: true,
      });
    });

    it("never fails, and never warns, when the app is not installed", async () => {
      const text = await runCli(["whoami"], { auth: versions(undefined) });
      expect(text.code).toBe(0);
      expect(/warning/i.test(text.stdout)).toBe(false);
      const json = await runCli(["whoami", "--json"], {
        auth: versions(undefined),
      });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout).app).toStrictEqual({
        installed: null,
        catalog: "0.72.0",
        newer: false,
      });
    });

    it("does not warn about a version it cannot compare", async () => {
      const run = await runCli(["whoami", "--json"], {
        auth: versions("nightly"),
      });
      expect(JSON.parse(run.stdout).app.newer).toBe(false);
    });

    it("still exits 1 when signed out, and still reports the app", async () => {
      const run = await runCli(["whoami", "--json"], {
        auth: fakeAuth({
          describe: async () => ({ source: "none" }),
          appVersions: async () => ({ installed: "0.73.0", catalog: "0.72.0" }),
        }),
      });
      expect(run.code).toBe(1);
      expect(JSON.parse(run.stdout).app.newer).toBe(true);
    });
  });
});

describe("help", () => {
  it("lists login, logout and whoami under Account", async () => {
    const run = await runCli(["--help"]);
    expect(run.stdout).toContain("Account:\n");
    expect(run.stdout).toMatch(
      /^ {2}login\s+Sign grokbot in through the browser/m,
    );
    expect(run.stdout).toMatch(/^ {2}logout\s+/m);
    expect(run.stdout).toMatch(/^ {2}whoami\s+/m);
  });

  it.each([[["help", "login"]], [["--help", "login"]], [["-h", "login"]]])(
    "%j prints login help like any other command",
    async (argv) => {
      const run = await runCli(argv);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("Usage: grokbot login");
    },
  );

  it("accepts flags before the command, as the rest of the CLI does", async () => {
    const run = await runCli(["--json", "whoami"], { auth: fakeAuth() });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ source: "cli" });
  });

  it("prints login help without building anything", async () => {
    const run = await runCli(["login", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      "Usage: grokbot login [--no-browser] [--api-key] [--json]",
    );
    expect(run.runnerOptions).toStrictEqual([]);
  });
});
