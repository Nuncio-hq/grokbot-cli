import { spawn } from "node:child_process";

/** `security` exit codes the store relies on, plus our own "could not run it". */
export const SECURITY_NOT_FOUND = 44;
export const SECURITY_NOT_RUNNABLE = 127;
/** Silent reads finish at once; a locked keychain must not hang a host on a GUI prompt. */
const SECURITY_TIMEOUT_MS = 15_000;
/** In prompt mode the owner needs time to read the macOS dialog and click Allow. */
export const SECURITY_PROMPT_TIMEOUT_MS = 60_000;

/** Runs `/usr/bin/security`; stdin carries any secret so it never reaches argv. */
export type KeychainRunner = (
  args: readonly string[],
  stdin?: string,
  options?: { readonly timeoutMs?: number },
) => Promise<{ readonly code: number | null; readonly stdout: string }>;

/** The real runner. A timeout kills `security` and reports code null, never "not found". */
export const runSecurity: KeychainRunner = (args, stdin, options) =>
  new Promise((resolve) => {
    const child = spawn("/usr/bin/security", [...args], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout: "" });
    }, options?.timeoutMs ?? SECURITY_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: SECURITY_NOT_RUNNABLE, stdout: "" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.stdin.end(stdin ?? "");
  });
