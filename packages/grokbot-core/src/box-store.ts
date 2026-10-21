import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import {
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { mapBounded } from "./map-bounded.js";
import { proxyFetch } from "./network-fetch.js";
import type { FetchLike } from "./server-transport.js";
import { asJsonObject, readString } from "./transcript.js";

/**
 * The bots' cloud computer, as the server mirrors it into its box store. This is the only
 * module that knows the store's layout (`manifest.json`, `blobs/<sha>`) and its RPCs; the
 * rest of grokbot sees cloud paths such as `/workspace/a/b.json`.
 *
 * The app only ever presigns blob reads, so the layout is not a published contract: any
 * answer in a shape this module does not expect fails with a plain error, never a guess.
 */

export interface BoxFile {
  readonly kind: "file";
  /** The cloud path, with its leading slash. */
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly mode: number;
}

interface BoxSymlink {
  readonly kind: "symlink";
  readonly path: string;
  readonly target: string;
}

export type BoxEntry = BoxFile | BoxSymlink;

/** One consistent view of the cloud computer's files, as of its last sync. */
export interface BoxSnapshot {
  /** When the server last wrote the manifest (ms). */
  readonly updatedAtMs: number;
  /** Every entry whose path is `prefix` or lies below it, sorted by path. */
  list(prefix: string): readonly BoxEntry[];
  get(path: string): BoxEntry | undefined;
}

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export interface BoxStore {
  /** The cloud computer's files. Costs one Stat call, plus a download only when the manifest changed. */
  snapshot(signal?: AbortSignal): Promise<BoxSnapshot>;
  /**
   * The UTF-8 text of each file, in order; undefined where the store holds no content for
   * it (not synced yet). A file larger than `maxBytes` throws. At most 8 downloads at once.
   */
  readTexts(
    files: readonly BoxFile[],
    options: ReadOptions & { readonly maxBytes: number },
  ): Promise<readonly (string | undefined)[]>;
  /** Copies the file's content to `destination` (0600, replaced atomically). */
  saveTo(
    file: BoxFile,
    destination: string,
    options?: ReadOptions,
  ): Promise<void>;
}

interface BoxStoreOptions {
  readonly server: ServerTransport;
  /** Default: global fetch, or the CONNECT tunnel when a proxy is configured. Only presigned URLs go through it. */
  readonly fetch?: FetchLike;
  /** Default: ~/.grokbot/cache/box-store. */
  readonly cacheDir?: string;
}

const MAX_PARALLEL_DOWNLOADS = 8;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Paths per presign call. */
const PRESIGN_BATCH = 50;
const MANIFEST_PATH = "manifest.json";
const SHA = /^[0-9a-f]{64}$/;

const unexpected = (what: string) =>
  new GrokBotError(
    "protocol",
    `The box store answered ${what} in a shape grokbot does not know. Its layout may have changed: update grokbot-cli.`,
  );

/** Absolute `/…` path with no empty, `.` or `..` segment, or undefined. */
export function cleanCloudPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.includes("\0")) return undefined;
  const segments = path.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return undefined;
  }
  return `/${segments.join("/")}`;
}

/** The object's etag; undefined when the store has none: `{}` is how proto JSON drops `exists: false`. */
function parseStat(raw: unknown): string | undefined {
  const o = asJsonObject(raw);
  if (!o) throw unexpected("StatSandBoxStoreObject");
  if (o.exists !== undefined && typeof o.exists !== "boolean") {
    throw unexpected("StatSandBoxStoreObject");
  }
  if (o.exists !== true) return undefined;
  const etag = readString(o, "etag");
  if (etag === undefined || etag === "") {
    throw unexpected("StatSandBoxStoreObject");
  }
  return etag;
}

function parsePresign(raw: unknown): ReadonlyMap<string, string> {
  const instructions = asJsonObject(raw)?.instructions;
  if (!Array.isArray(instructions)) {
    throw unexpected("PresignSandBoxStoreReads");
  }
  const urls = new Map<string, string>();
  for (const item of instructions) {
    const o = asJsonObject(item);
    const relPath = o && readString(o, "relPath");
    const url = o && readString(o, "url");
    if (!relPath || !url || !/^https?:\/\//.test(url)) {
      throw unexpected("PresignSandBoxStoreReads");
    }
    urls.set(relPath, url);
  }
  return urls;
}

function parseManifest(text: string): {
  readonly updatedAtMs: number;
  readonly entries: readonly BoxEntry[];
} {
  let root: JsonObject | undefined;
  try {
    root = asJsonObject(JSON.parse(text));
  } catch {
    root = undefined;
  }
  const raw = root && asJsonObject(root.entries);
  if (!root || !raw) throw unexpected("manifest.json");
  const entries: BoxEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const o = asJsonObject(value);
    const path = cleanCloudPath(`/${key}`);
    if (!o || path === undefined) throw unexpected("manifest.json");
    if (o.kind === "file") {
      const sha = readString(o, "sha");
      if (sha === undefined || !SHA.test(sha))
        throw unexpected("manifest.json");
      const size = typeof o.size === "number" ? o.size : Number(o.size ?? 0);
      const mode = typeof o.mode === "number" ? o.mode : 0;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw unexpected("manifest.json");
      }
      entries.push({ kind: "file", path, sha, size, mode });
    } else if (o.kind === "symlink") {
      entries.push({
        kind: "symlink",
        path,
        target: readString(o, "target") ?? "",
      });
    }
    // Other kinds (none seen live) are not files grokbot can read; they are left out.
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const updatedAtMs = Number(root.updatedAtMs ?? 0);
  return {
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    entries,
  };
}

function snapshotOf(
  updatedAtMs: number,
  entries: readonly BoxEntry[],
): BoxSnapshot {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return {
    updatedAtMs,
    get: (path) => byPath.get(path),
    list(prefix) {
      const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
      return entries.filter((e) => e.path === prefix || e.path.startsWith(dir));
    },
  };
}

/** Fills a temp file, then renames it over `path`. `write` returns false to keep nothing. */
async function writeAtomic(
  path: string,
  write: (temp: string) => Promise<unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    if ((await write(temp)) === false) return;
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function boxStore(options: BoxStoreOptions): BoxStore {
  const { server } = options;
  const doFetch = options.fetch ?? proxyFetch;
  const cacheDir =
    options.cacheDir ?? join(homedir(), ".grokbot", "cache", "box-store");
  const manifestFile = join(cacheDir, "manifest.json");
  const etagFile = join(cacheDir, "manifest.etag");
  const blobFile = (sha: string) => join(cacheDir, "blobs", sha);
  /** The parsed manifest of the newest etag seen by this store. */
  let memo:
    | { readonly etag: string; readonly snapshot: BoxSnapshot }
    | undefined;

  /** The presigned URL of each path, in order; every one must be answered. */
  const presign = async (
    relPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly string[]> => {
    const urls = parsePresign(
      await server.call("PresignSandBoxStoreReads", { relPaths }, { signal }),
    );
    return relPaths.map((relPath) => {
      const url = urls.get(relPath);
      if (url === undefined) throw unexpected("PresignSandBoxStoreReads");
      return url;
    });
  };

  /**
   * Streams one presigned URL into `destination`. False when the store answers 404.
   * The URL is a bearer link: no error carries it, and the transport's own error (which
   * may quote the URL) is never chained.
   */
  const download = async (
    url: string,
    what: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    let found = true;
    try {
      await writeAtomic(destination, async (temp) => {
        const response = await doFetch(url, {
          method: "GET",
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (response.status === 404) {
          found = false;
          return false;
        }
        if (!response.ok || response.body === null) {
          throw new GrokBotError(
            "http",
            `The box store refused to serve ${what} (HTTP ${response.status}).`,
          );
        }
        // The DOM and node:stream/web ReadableStream types differ only on paper.
        const body = response.body as unknown as NodeWebStream;
        await pipeline(
          Readable.fromWeb(body),
          createWriteStream(temp, { mode: 0o600 }),
        );
        return true;
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof GrokBotError) throw error;
      throw new GrokBotError(
        "http",
        `Downloading ${what} from the box store failed.`,
      );
    }
    return found;
  };

  const loadManifest = async (
    etag: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const cached = await readFile(etagFile, "utf8").catch(() => undefined);
    if (cached === etag) {
      const text = await readFile(manifestFile, "utf8").catch(() => undefined);
      if (text !== undefined) {
        try {
          parseManifest(text);
          return text;
        } catch {
          // A damaged cache file is fetched again.
        }
      }
    }
    const [url] = await presign([MANIFEST_PATH], signal);
    if (
      url === undefined ||
      !(await download(url, "the manifest", manifestFile, signal))
    ) {
      throw new GrokBotError(
        "not-found",
        "The box store has no manifest: the bots' cloud computer has not synced yet.",
      );
    }
    // The etag goes last, so a stored etag always has its manifest behind it.
    await writeAtomic(etagFile, (temp) =>
      writeFile(temp, etag, { mode: 0o600 }),
    );
    return readFile(manifestFile, "utf8");
  };

  /** Blob content on disk, from the permanent cache or downloaded now; false when the store lacks it. */
  const ensureBlobs = async (
    shas: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>> => {
    const unique = [...new Set(shas)];
    const cached = await Promise.all(
      unique.map((sha) =>
        stat(blobFile(sha)).then(
          () => true,
          () => false,
        ),
      ),
    );
    const present = new Set(unique.filter((_, i) => cached[i]));
    const missing = unique.filter((sha) => !present.has(sha));
    for (let i = 0; i < missing.length; i += PRESIGN_BATCH) {
      const batch = missing.slice(i, i + PRESIGN_BATCH);
      const urls = await presign(
        batch.map((sha) => `blobs/${sha}`),
        signal,
      );
      const jobs = batch.map((sha, index) => ({ sha, url: urls[index] ?? "" }));
      await mapBounded(jobs, MAX_PARALLEL_DOWNLOADS, async ({ sha, url }) => {
        const what = `blob ${sha.slice(0, 8)}`;
        if (await download(url, what, blobFile(sha), signal)) present.add(sha);
      });
    }
    return present;
  };

  return {
    async snapshot(signal) {
      const etag = parseStat(
        await server.call(
          "StatSandBoxStoreObject",
          { relPath: MANIFEST_PATH },
          { signal },
        ),
      );
      if (etag === undefined) {
        throw new GrokBotError(
          "not-found",
          "The box store has no manifest: the bots' cloud computer has not synced yet.",
        );
      }
      if (memo?.etag === etag) return memo.snapshot;
      const { updatedAtMs, entries } = parseManifest(
        await loadManifest(etag, signal),
      );
      memo = { etag, snapshot: snapshotOf(updatedAtMs, entries) };
      return memo.snapshot;
    },

    async readTexts(files, { maxBytes, signal }) {
      for (const file of files) {
        if (file.size > maxBytes) {
          throw new GrokBotError(
            "safety",
            `${file.path} is ${file.size} bytes, more than the ${maxBytes} grokbot reads as text.`,
          );
        }
      }
      const present = await ensureBlobs(
        files.map((f) => f.sha),
        signal,
      );
      return mapBounded(files, MAX_PARALLEL_DOWNLOADS, async (file) => {
        if (!present.has(file.sha)) return undefined;
        const bytes = await readFile(blobFile(file.sha));
        if (bytes.length > maxBytes) {
          throw new GrokBotError(
            "safety",
            `${file.path} holds more than the ${maxBytes} bytes grokbot reads as text.`,
          );
        }
        return bytes.toString("utf8");
      });
    },

    async saveTo(file, destination, { signal } = {}) {
      const present = await ensureBlobs([file.sha], signal);
      if (!present.has(file.sha)) {
        throw new GrokBotError(
          "not-found",
          `The box store has no content for ${file.path} yet; the cloud computer may still be syncing. Try again in a minute.`,
        );
      }
      await writeAtomic(destination, (temp) =>
        copyFile(blobFile(file.sha), temp),
      );
    },
  };
}
