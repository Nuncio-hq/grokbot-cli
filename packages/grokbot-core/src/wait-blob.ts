import type { ServerTransport } from "./contracts.js";
import type { ReplyEntry } from "./done-rule.js";
import type { FetchLike } from "./server-transport.js";
import {
  asJsonObject,
  type BlobEntry,
  parseBlobBody,
  readString,
} from "./transcript.js";

const GET_TIMEOUT_MS = 30_000;
const PATH_KEYS = ["relPath", "rel_path", "path"];
const URL_KEYS = ["url", "presignedUrl", "signedUrl", "downloadUrl"];

const firstString = (o: Record<string, unknown>, keys: readonly string[]) =>
  keys.map((k) => readString(o, k)).find((v) => v !== undefined);

/** The response's field names were never seen live, so take any listed read whose URL is http(s). */
function presignedUrl(raw: unknown, relPath: string): string | undefined {
  for (const list of Object.values(asJsonObject(raw) ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const read = asJsonObject(item);
      if (!read) continue;
      const path = firstString(read, PATH_KEYS);
      const url = firstString(read, URL_KEYS);
      const matches = path === undefined || path === relPath;
      if (matches && url !== undefined && /^https?:\/\//.test(url)) return url;
    }
  }
  return undefined;
}

export interface BlobReadOptions {
  readonly server: ServerTransport;
  readonly signal: AbortSignal;
  readonly fetch?: FetchLike;
}

/**
 * Downloads a blob row's body through PresignSandBoxStoreReads and a plain GET.
 * Returns the text reply it holds, or undefined on any failure or other shape.
 * The presigned URL is a bearer link, so no error or result ever carries it.
 */
export async function readBlobReply(
  blob: BlobEntry,
  { server, signal, fetch = globalThis.fetch }: BlobReadOptions,
): Promise<ReplyEntry | undefined> {
  const relPath = `blobs/${blob.blobHash}`;
  try {
    const presigned = await server.call(
      "PresignSandBoxStoreReads",
      { relPaths: [relPath] },
      { signal },
    );
    const url = presignedUrl(presigned, relPath);
    if (url === undefined) return undefined;
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.any([signal, AbortSignal.timeout(GET_TIMEOUT_MS)]),
    });
    if (!response.ok) return undefined;
    const entry = parseBlobBody(blob, await response.json());
    const finished = entry.kind === "reply" && entry.isStreaming !== true;
    return finished && entry.reply.type === "text" ? entry : undefined;
  } catch {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}
