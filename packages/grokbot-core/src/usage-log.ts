import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandName } from "./command-catalog.js";
import type { ClientLabel } from "./usage-client.js";

/** How a command ended: a job's outcome, `sent`/`queued` for send, `ok` otherwise, or `error`. */
export type UsageStatus =
  | "done"
  | "ambiguous"
  | "awaiting-approval"
  | "pending"
  | "sent"
  | "queued"
  | "ok"
  | "error";

export const DURATION_BUCKETS = ["<1s", "<10s", "<1m", "<5m", ">=5m"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/**
 * One command run. Only these fields are ever written: no message text, replies, bot names
 * or ids, job ids, tokens, paths or repo names. `flags` holds input names, never values.
 */
export interface UsageEvent {
  readonly v: 1;
  /** Local hour of the run, e.g. "2026-10-16T22". */
  readonly hour: string;
  readonly command: CommandName;
  readonly surface: "cli" | "mcp";
  readonly client: ClientLabel;
  readonly status: UsageStatus;
  /** GrokBotError code of a failed run, or "other". */
  readonly errorCode?: string;
  readonly duration: DurationBucket;
  readonly flags: readonly string[];
  /** Which kind of bot it targeted, when the result names one. */
  readonly bot?: "main" | "test" | "other";
  readonly version: string;
  readonly os: string;
}

export const DEFAULT_USAGE_DIR = join(homedir(), ".grokbot", "usage");
/** Months kept: this one and the two before, so about 90 days. */
const KEEP_MONTHS = 3;
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;

export function durationBucket(ms: number): DurationBucket {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "<10s";
  if (ms < 60_000) return "<1m";
  if (ms < 300_000) return "<5m";
  return ">=5m";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local hour of `ms`, e.g. "2026-10-16T22". */
export function localHour(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
}

const monthIndex = (year: number, month: number) => year * 12 + month - 1;

function isUsageEvent(value: unknown): value is UsageEvent {
  const o = value as Partial<UsageEvent> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    o.v === 1 &&
    typeof o.hour === "string" &&
    typeof o.command === "string" &&
    typeof o.client === "string" &&
    typeof o.status === "string" &&
    Array.isArray(o.flags)
  );
}

export interface UsageLog {
  readonly dir: string;
  /** Appends one event to this month's file (0600) and drops months older than ~90 days. */
  append(event: UsageEvent, nowMs?: number): Promise<void>;
  /** Every saved event with an hour at or after `sinceHour`, oldest file first. */
  read(sinceHour?: string): Promise<UsageEvent[]>;
}

export function usageLog(dir: string = DEFAULT_USAGE_DIR): UsageLog {
  const months = async () => {
    try {
      return (await readdir(dir)).filter((n) => MONTH_FILE.test(n)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    dir,
    async append(event, nowMs = Date.now()) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const now = new Date(nowMs);
      const file = `${now.getFullYear()}-${pad(now.getMonth() + 1)}.jsonl`;
      await appendFile(join(dir, file), `${JSON.stringify(event)}\n`, {
        mode: 0o600,
      });
      const oldest =
        monthIndex(now.getFullYear(), now.getMonth() + 1) - (KEEP_MONTHS - 1);
      for (const name of await months()) {
        const [, y, m] = MONTH_FILE.exec(name) ?? [];
        if (monthIndex(Number(y), Number(m)) < oldest)
          await rm(join(dir, name), { force: true });
      }
    },
    async read(sinceHour) {
      const events: UsageEvent[] = [];
      for (const name of await months()) {
        const text = await readFile(join(dir, name), "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // A torn line from a crash mid-write; the rest of the file still counts.
          }
          if (isUsageEvent(parsed) && (!sinceHour || parsed.hour >= sinceHour))
            events.push(parsed);
        }
      }
      return events;
    },
  };
}
