import {
  type ClientHttp2Session,
  connect,
  constants,
  type IncomingHttpHeaders,
} from "node:http2";
import { type Duplex, pipeline, Readable } from "node:stream";
import type { ConnectionOptions } from "node:tls";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  constants as zlib,
} from "node:zlib";
import type { FetchLike } from "./server-transport.js";

interface Http2FetchOptions {
  /** A connect plus TLS handshake slower than this fails. Default 10 s, as undici. */
  readonly connectTimeoutMs?: number;
  /** A response silent this long fails, so a dead Watch stream reconnects. Default 300 s, as undici. */
  readonly silenceTimeoutMs?: number;
  /** An unused connection closes after this, so a call never lands on one that died. Default 4 s, as undici. */
  readonly idleCloseMs?: number;
  /**
   * Opens the byte stream HTTP/2 runs on, for an origin that must not be dialed directly
   * (a proxy tunnel). Return undefined to dial directly. May throw or reject: the call fails.
   */
  readonly openSocket?: (origin: URL) => Promise<Duplex> | undefined;
  /** Extra trusted certificate authorities for direct connections, on top of the default store. */
  readonly ca?: ConnectionOptions["ca"];
}

interface Connection {
  readonly session: ClientHttp2Session;
  active: number;
  idle?: ReturnType<typeof setTimeout>;
}

export const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/**
 * Receive window per stream and per connection. HTTP/2's default 64 KB makes a few
 * transcript pages read together wait one round trip per 64 KB for window updates.
 */
const WINDOW_BYTES = 16 * 1024 * 1024;

/**
 * fetch over one HTTP/2 connection per origin. Calls made together share it, where
 * HTTP/1.1 fetch opens a new TCP + TLS connection (two extra round trips) for each.
 * Sends string or byte bodies only. An idle connection never keeps the process alive.
 */
export function createHttp2Fetch({
  connectTimeoutMs = 10_000,
  silenceTimeoutMs = 300_000,
  idleCloseMs = 4_000,
  openSocket,
  ca,
}: Http2FetchOptions = {}): FetchLike {
  // A promise while a tunnel is being opened, so calls made together share it.
  const pool = new Map<string, Connection | Promise<Connection>>();

  const start = (origin: string, socket?: Duplex): Connection => {
    const session = connect(origin, {
      settings: { initialWindowSize: WINDOW_BYTES },
      ...(socket === undefined ? {} : { createConnection: () => socket }),
      ...(ca === undefined ? {} : { ca }),
    });
    const connection: Connection = { session, active: 0 };
    const connecting = setTimeout(
      () => session.destroy(new Error(`connecting to ${origin} timed out`)),
      connectTimeoutMs,
    );
    connecting.unref();
    const forget = () => {
      clearTimeout(connecting);
      if (pool.get(origin) === connection) pool.delete(origin);
    };
    // Open streams get the error too; this listener only keeps it from crashing the process.
    session.on("error", forget);
    session.once("close", forget);
    session.once("goaway", forget);
    session.once("connect", () => {
      clearTimeout(connecting);
      session.setLocalWindowSize(WINDOW_BYTES);
    });
    session.unref();
    pool.set(origin, connection);
    return connection;
  };

  const open = (origin: string): Connection | Promise<Connection> => {
    const found = pool.get(origin);
    if (found instanceof Promise) return found;
    if (found && !found.session.closed && !found.session.destroyed) {
      return found;
    }
    const opening = openSocket?.(new URL(origin));
    if (opening === undefined) return start(origin);
    const pending = opening.then((socket) => start(origin, socket));
    pool.set(origin, pending);
    pending.catch(() => {
      if (pool.get(origin) === pending) pool.delete(origin);
    });
    return pending;
  };

  const hold = (connection: Connection) => {
    clearTimeout(connection.idle);
    if (connection.active++ === 0) connection.session.ref();
  };

  const release = (connection: Connection) => {
    if (--connection.active > 0) return;
    connection.session.unref();
    connection.idle = setTimeout(() => connection.session.close(), idleCloseMs);
    connection.idle.unref();
  };

  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const { signal } = init;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const target = new URL(url);
      const body = bodyOf(init.body);
      const headers: Record<string, string> = {
        ":method": init.method ?? "GET",
        ":path": `${target.pathname}${target.search}`,
        // As fetch does: transcript pages shrink about 3x, which saves round trips.
        "accept-encoding": "gzip, deflate, br",
      };
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const send = (connection: Connection) => {
        const stream = connection.session.request(headers);
        hold(connection);
        // Cancel on the server, and destroy with the reason so a body read in progress
        // rejects instead of ending short.
        const abort = () => {
          stream.close(constants.NGHTTP2_CANCEL);
          stream.destroy(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        stream.once("close", () => {
          signal?.removeEventListener("abort", abort);
          release(connection);
        });
        // Before the response this rejects the call; after it, the body stream reports the error.
        stream.on("error", reject);
        // A stream can also close before its response with no error at all: the server
        // cancelled it, or the connection under it ended cleanly (a proxy that dropped the
        // tunnel shows up that way on Linux). Reject then too, or the call would wait
        // forever; once the response is in, this does nothing.
        stream.once("close", () =>
          reject(
            new Error(
              `${target.pathname} closed before a response (HTTP/2 code ${stream.rstCode ?? "none"})`,
            ),
          ),
        );
        // A timer of our own: Bun routes Http2Stream.setTimeout to the shared session, which
        // adds a never-removed "timeout" listener per call (MaxListenersExceededWarning) and
        // times the whole connection, not this stream.
        const silence = setTimeout(
          () =>
            stream.destroy(
              new Error(
                `${target.pathname} was silent for ${silenceTimeoutMs} ms`,
              ),
            ),
          silenceTimeoutMs,
        );
        stream.once("close", () => clearTimeout(silence));
        stream.once("response", (raw) => {
          silence.refresh();
          const status = Number(raw[":status"]);
          const headers = responseHeaders(raw);
          if (NULL_BODY_STATUSES.has(status)) {
            stream.resume();
            resolve(new Response(null, { status, headers }));
            return;
          }
          const decoder = decoderFor(headers.get("content-encoding"));
          // pipeline passes an abort or reset on to the decoder, so the body read rejects.
          const decoded = decoder
            ? pipeline(stream, decoder, () => {})
            : stream;
          // node:stream/web and the global ReadableStream typings differ; same runtime class.
          const web = Readable.toWeb(decoded) as unknown as ReadableStream;
          // After the body is wired up, so this listener never starts the flow on its own.
          stream.on("data", () => silence.refresh());
          resolve(new Response(web, { status, headers }));
        });
        stream.end(body);
      };
      const connection = open(target.origin);
      if (!(connection instanceof Promise)) {
        send(connection);
        return;
      }
      // A tunnel is still opening. This call stops waiting on abort; the shared
      // connection keeps opening for the others.
      const stopWaiting = () => reject(signal?.reason);
      signal?.addEventListener("abort", stopWaiting, { once: true });
      connection.then(
        (ready) => {
          signal?.removeEventListener("abort", stopWaiting);
          if (signal?.aborted) {
            hold(ready);
            release(ready);
            return;
          }
          try {
            send(ready);
          } catch (error) {
            reject(error);
          }
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", stopWaiting);
          reject(error);
        },
      );
    });
}

export function bodyOf(
  body: RequestInit["body"],
): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  throw new TypeError("http2 fetch sends string or byte bodies only.");
}

/** Lenient like undici: a body cut short yields what arrived rather than failing. */
export function decoderFor(encoding: string | null) {
  const lenient = { flush: zlib.Z_SYNC_FLUSH, finishFlush: zlib.Z_SYNC_FLUSH };
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return createGunzip(lenient);
    case "deflate":
      return createInflate(lenient);
    case "br":
      return createBrotliDecompress({
        flush: zlib.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.BROTLI_OPERATION_FLUSH,
      });
    default:
      return undefined;
  }
}

export function responseHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith(":") || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      headers.append(name, one);
    }
  }
  return headers;
}
