import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CATALOG_APP_VERSION,
  createTokenSource,
  credentialStore,
  loginWithApiKey,
  loginWithBrowser,
  readInstalledAppVersion,
} from "grokbot-core";
import { renderUnicodeCompact } from "uqr";
import type { AuthDeps } from "./auth-command.js";

/** A piped key arrives at once; a pipe that never closes must not hang `login --api-key`. */
const STDIN_TIMEOUT_MS = 5_000;

/** The real side effects of login/logout/whoami: Keychain, browser, stdin, QR. */
export function defaultAuthDeps(): AuthDeps {
  const store = credentialStore();
  const run = promisify(execFile);
  return {
    loginWithBrowser: (options) => loginWithBrowser({ ...options, store }),
    loginWithApiKey: (apiKey) => loginWithApiKey(apiKey, { store }),
    clear: () => store.clear(),
    describe: () => createTokenSource({ store }).describe(),
    appVersions: async () => ({
      installed: await readInstalledAppVersion(),
      catalog: CATALOG_APP_VERSION,
    }),
    openUrl: async (url) => {
      await run("open", [url]);
    },
    readStdin: () => readPipedStdin(STDIN_TIMEOUT_MS),
    renderQr: (url) => `${renderUnicodeCompact(url)}\n`,
  };
}

/** Reads piped stdin, or "" for a terminal or a pipe that stays open past the timeout. */
async function readPipedStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return true;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const finished = await Promise.race([done, timedOut]);
  clearTimeout(timer);
  if (!finished) {
    process.stdin.pause();
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}
