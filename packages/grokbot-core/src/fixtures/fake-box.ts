import { createHash } from "node:crypto";
import type { JsonObject, ServerTransport } from "../contracts.js";
import { fakeServer, type RecordedCall } from "./fake-server.js";

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export interface FakeBox {
  readonly state: {
    etag: string;
    files: Record<string, string>;
    readonly withheld: Set<string>;
  };
  readonly server: ServerTransport;
  /** The store's two RPCs, to merge into a larger fake server. */
  readonly calls: Readonly<Record<string, (body: JsonObject) => unknown>>;
  readonly log: readonly RecordedCall[];
  readonly fetch: (url: string) => Promise<Response>;
  readonly gets: readonly string[];
  readonly presigned: readonly (readonly string[])[];
  /** Downloads in flight right now, and the most at once. */
  readonly inFlight: () => number;
  readonly maxInFlight: () => number;
  /** While held, every download waits; resolves once `count` downloads are waiting. */
  hold(count: number): { readonly saturated: Promise<void>; release(): void };
}

/** A fake box store: a manifest, blobs by sha, presigned URLs that look like bearer links. */
export function fakeBox(files: Readonly<Record<string, string>>): FakeBox {
  const state = {
    etag: "etag-1",
    files: { ...files },
    withheld: new Set<string>(),
  };
  const gets: string[] = [];
  const presigned: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let gate: Promise<void> | undefined;
  let saturate: (() => void) | undefined;
  let saturateAt = Number.POSITIVE_INFINITY;
  const manifest = () =>
    JSON.stringify({
      version: 2,
      updatedAtMs: 1_790_000_000_000,
      writerWindowId: "w",
      entries: {
        ...Object.fromEntries(
          Object.entries(state.files).map(([path, text]) => [
            path.replace(/^\//, ""),
            { kind: "file", sha: sha256(text), size: text.length, mode: 420 },
          ]),
        ),
        "workspace/link": { kind: "symlink", target: "a" },
      },
    });
  const body = (relPath: string): string | undefined => {
    if (relPath === "manifest.json") return manifest();
    const sha = relPath.replace("blobs/", "");
    return Object.values(state.files).find((text) => sha256(text) === sha);
  };
  const calls = {
    StatSandBoxStoreObject: () => ({
      exists: true,
      etag: state.etag,
      sizeBytes: "1",
      lastModifiedMs: "1",
    }),
    PresignSandBoxStoreReads: (request: JsonObject) => {
      const relPaths = request.relPaths as string[];
      presigned.push(relPaths);
      return {
        instructions: relPaths.map((relPath) => ({
          relPath,
          url: `https://store.example/${encodeURIComponent(relPath)}?sig=bearer-secret`,
          expiresAtMs: "1",
        })),
      };
    },
  };
  const { server, log } = fakeServer({ calls });
  const fetch = async (url: string): Promise<Response> => {
    gets.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight >= saturateAt) saturate?.();
    await gate;
    inFlight--;
    const relPath = decodeURIComponent(new URL(url).pathname.slice(1));
    const text = state.withheld.has(relPath) ? undefined : body(relPath);
    return text === undefined
      ? new Response("missing", { status: 404 })
      : new Response(text);
  };
  return {
    state,
    server,
    calls,
    log,
    fetch,
    gets,
    presigned,
    inFlight: () => inFlight,
    maxInFlight: () => maxInFlight,
    hold(count) {
      const held = Promise.withResolvers<void>();
      const saturated = Promise.withResolvers<void>();
      gate = held.promise;
      saturate = saturated.resolve;
      saturateAt = count;
      return { saturated: saturated.promise, release: held.resolve };
    },
  };
}
