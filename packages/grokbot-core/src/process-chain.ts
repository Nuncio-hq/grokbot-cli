import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * The programs that started grokbot, nearest first: the names of its parent, grandparent
 * and so on. A runtime started inside another one inherits the outer runtime's
 * environment, but its own process is the nearest one on this chain, so the chain names
 * the runtime that really called. Only executable and script names are ever read, in
 * memory: command lines are never kept or reported.
 */
export type ProcessChain = () => readonly string[];

/** How many parents are followed. */
export const MAX_CHAIN_DEPTH = 15;

/** Programs that run a script: for these the script's name, not the program's, names the process. */
const INTERPRETERS = /^(node|nodejs|bun|python|python\d+(\.\d+)*)$/;
/** Words that sit between an interpreter and its script, such as `bun run <script>`. */
const SCRIPT_VERBS: Record<string, true> = { run: true, x: true, exec: true };
const SCRIPT_EXTENSION = /\.(m?js|cjs|ts|py)$/;

interface ProcessRow {
  readonly ppid: number;
  /** The program's path or name: the rest of the row, so it may hold spaces. */
  readonly program: string;
}

/**
 * Rows of `ps -A -o pid=,ppid=,comm=`, by pid. A row is `pid ppid program`, where the
 * program is the whole rest of the row. `comm` must be the last column: `ps` cuts it to
 * 16 characters whenever another column follows, which loses the executable's name.
 */
function parseTable(table: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      program: match[3] ?? "",
    });
  }
  return rows;
}

const programName = (program: string): string =>
  basename(program).toLowerCase().replace(/^-/, "");

/**
 * The script each pid runs, from the text of `ps -o pid=,args= -p <pids>`: the first word
 * after the program that is neither a flag nor a verb such as `run`, by basename without
 * extension. Pids whose command line names no script are left out.
 */
function parseScripts(table: string): Map<number, string> {
  const scripts = new Map<number, string>();
  for (const line of table.split("\n")) {
    const [pidText, , ...rest] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid)) continue;
    const script = rest.find(
      (word) => !word.startsWith("-") && !Object.hasOwn(SCRIPT_VERBS, word),
    );
    if (script !== undefined) {
      scripts.set(
        pid,
        basename(script).toLowerCase().replace(SCRIPT_EXTENSION, ""),
      );
    }
  }
  return scripts;
}

/**
 * The names of the processes from `startPid` upward, nearest first, at most
 * `MAX_CHAIN_DEPTH` of them. `table` is the text of `ps -A -o pid=,ppid=,comm=`. A process
 * that is an interpreter is named by its script instead: `readArgs` is called once, with
 * just those pids and only when there are any, and returns the text of
 * `ps -o pid=,args= -p <pids>`.
 */
export function walkProcessChain(
  table: string,
  startPid: number,
  readArgs: (pids: readonly number[]) => string,
): readonly string[] {
  const rows = parseTable(table);
  const chain: { readonly pid: number; readonly name: string }[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (chain.length < MAX_CHAIN_DEPTH && pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const row = rows.get(pid);
    if (row === undefined) break;
    chain.push({ pid, name: programName(row.program) });
    pid = row.ppid;
  }
  const interpreters = chain
    .filter(({ name }) => INTERPRETERS.test(name))
    .map((entry) => entry.pid);
  if (interpreters.length === 0) return chain.map(({ name }) => name);
  let scripts = new Map<number, string>();
  try {
    scripts = parseScripts(readArgs(interpreters));
  } catch {
    // The interpreters keep their own names.
  }
  return chain.map(({ pid, name }) => scripts.get(pid) ?? name);
}

let cached: readonly string[] | undefined;

const ps = (args: readonly string[]): string =>
  execFileSync("ps", [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * The real chain of this process, from one `ps` call (plus one for the command lines of
 * interpreters on the chain), read once per process. A missing `ps` or a failed call
 * gives an empty chain, so detection goes on with the environment.
 */
export const readProcessChain: ProcessChain = () => {
  if (cached !== undefined) return cached;
  try {
    cached = walkProcessChain(
      ps(["-A", "-o", "pid=,ppid=,comm="]),
      process.ppid,
      (pids) => ps(["-o", "pid=,args=", "-p", pids.join(",")]),
    );
  } catch {
    cached = [];
  }
  return cached;
};
