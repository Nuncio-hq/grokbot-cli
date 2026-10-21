import { request as httpsRequest } from "node:https";
import { pipeline, Readable } from "node:stream";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { GrokBotError } from "./contracts.js";
import {
  bodyOf,
  createHttp2Fetch,
  decoderFor,
  NULL_BODY_STATUSES,
  responseHeaders,
} from "./http2-fetch.js";
import { type ProxyEnv, resolveProxy } from "./proxy-config.js";
import { openTunnel } from "./proxy-tunnel.js";
import type { FetchLike } from "./server-transport.js";

export interface NetworkOptions {
  /** Where the proxy variables are read, on every call. Default: process.env. */
  readonly env?: ProxyEnv;
  /** Extra trusted certificate authorities for servers reached through a proxy. For tests; production uses the default store. */
  readonly ca?: ConnectionOptions["ca"];
  /** A proxy connect, CONNECT reply and TLS handshake slower than this fails. Default 10 s. */
  readonly connectTimeoutMs?: number;
}

/** The server behind a proxy would not speak HTTP/2; backend calls then use HTTP/1.1 over the tunnel. */
class NoHttp2Error extends Error {}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const REDIRECTS: Record<number, true | undefined> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

/**
 * Global fetch, except an https URL the proxy settings apply to: that goes through an
 * HTTP CONNECT tunnel with HTTP/1.1 inside. With no proxy configured it is global fetch
 * and nothing more. A tunnelled GET or HEAD follows redirects, as fetch does.
 */
export function createProxyFetch(options: NetworkOptions = {}): FetchLike {
  const viaProxy = async (
    url: string,
    init: RequestInit,
    hops: number,
  ): Promise<Response> => {
    const proxy = resolveProxy(url, options.env);
    if (proxy === null) return globalThis.fetch(url, init);
    const target = new URL(url);
    const socket = await openTunnel({
      proxy,
      host: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port === "" ? 443 : Number(target.port),
      alpn: ["http/1.1"],
      timeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    let response: Response;
    try {
      response = await requestOver(socket, target, init);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    const location = response.headers.get("location");
    const method = init.method ?? "GET";
    if (
      location === null ||
      REDIRECTS[response.status] === undefined ||
      (method !== "GET" && method !== "HEAD")
    ) {
      return response;
    }
    await response.body?.cancel();
    if (hops >= MAX_REDIRECTS) {
      throw new GrokBotError(
        "http",
        "A request was redirected too many times.",
      );
    }
    const next = new URL(location, target);
    const headers = new Headers(init.headers);
    // A bearer token or cookie never follows a redirect to another origin.
    if (next.origin !== target.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    return viaProxy(next.toString(), { ...init, headers }, hops + 1);
  };
  return (url, init) => viaProxy(url, init, 0);
}

/**
 * The backend gets one shared HTTP/2 connection per process, opened through the proxy
 * tunnel when the proxy settings apply to it; other hosts use the proxy-aware fetch.
 * If the server will not agree to HTTP/2 inside the tunnel (some TLS-inspecting proxies
 * offer HTTP/1.1 only), backend calls fall back to HTTP/1.1 over a tunnel per call.
 */
export function createBackendFetch(
  backendUrl: string,
  options: NetworkOptions = {},
): FetchLike {
  const others = createProxyFetch(options);
  let backend: FetchLike | undefined;
  let http1Only = false;
  return (url, init) => {
    if (http1Only || !url.startsWith(`${backendUrl}/`)) {
      return others(url, init);
    }
    backend ??= createHttp2Fetch({
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
      openSocket: (origin) => {
        const proxy = resolveProxy(origin, options.env);
        if (proxy === null) return undefined;
        return openTunnel({
          proxy,
          host: origin.hostname.replace(/^\[|\]$/g, ""),
          port: origin.port === "" ? 443 : Number(origin.port),
          alpn: ["h2", "http/1.1"],
          timeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        }).then((socket) => {
          if (socket.alpnProtocol === "h2") return socket;
          socket.destroy();
          throw new NoHttp2Error();
        });
      },
    });
    return backend(url, init).catch((error: unknown) => {
      if (!(error instanceof NoHttp2Error)) throw error;
      http1Only = true;
      return others(url, init);
    });
  };
}

/** The default for every https call that is not the backend's HTTP/2 connection. */
export const proxyFetch: FetchLike = createProxyFetch();

/** One HTTP/1.1 request on a tunnel that is already secured; the tunnel closes with it. */
function requestOver(
  socket: TLSSocket,
  target: URL,
  init: RequestInit,
): Promise<Response> {
  // Not Promise.withResolvers: that needs Node 22, and grokbot supports Node 20.3.
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const { signal } = init;
  const body = bodyOf(init.body);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const request = httpsRequest(target, {
    method: init.method ?? "GET",
    headers,
    // No agent: it would dial the host itself instead of using the tunnel.
    agent: undefined,
    createConnection: () => socket,
  });
  const abort = () => {
    request.destroy();
    socket.destroy(signal?.reason);
    reject(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal?.removeEventListener("abort", abort));
  request.once("error", reject);
  request.once("response", (raw) => {
    const status = raw.statusCode ?? 0;
    const responseHead = responseHeaders(raw.headers);
    if (request.method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
      raw.resume();
      resolve(new Response(null, { status, headers: responseHead }));
      return;
    }
    const decoder = decoderFor(responseHead.get("content-encoding"));
    const decoded = decoder ? pipeline(raw, decoder, () => {}) : raw;
    const web = Readable.toWeb(decoded) as unknown as ReadableStream;
    resolve(new Response(web, { status, headers: responseHead }));
  });
  request.end(body);
  return promise;
}
