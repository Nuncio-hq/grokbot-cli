import { isIP, connect as netConnect, type Socket } from "node:net";
import {
  type ConnectionOptions,
  type TLSSocket,
  connect as tlsConnect,
} from "node:tls";
import { hostWithPort, type ProxyConfig, ProxyError } from "./proxy-config.js";

export interface TunnelRequest {
  readonly proxy: ProxyConfig;
  /** The server to reach: host name or IP without brackets. */
  readonly host: string;
  readonly port: number;
  /** ALPN protocols offered to the server: `h2` for HTTP/2, `http/1.1` otherwise. */
  readonly alpn: readonly string[];
  /** The proxy connect, CONNECT reply and TLS handshake together. */
  readonly timeoutMs: number;
  /** Extra trusted certificate authorities for the proxy (an https proxy) and the server, on top of the default store. */
  readonly ca?: ConnectionOptions["ca"];
  readonly signal?: AbortSignal;
}

const MAX_REPLY_BYTES = 16 * 1024;
const GIVE_UP_HINT =
  "Check the proxy settings, or set GROKBOT_HTTPS_PROXY=off to connect directly.";

/**
 * Opens an HTTP CONNECT tunnel through the proxy and a TLS session to the server inside
 * it, with normal certificate checks against the server's own name. Resolves with the
 * secured socket. Every failure is a GrokBotError naming the proxy's host:port only,
 * never the proxy URL or its credentials.
 */
export function openTunnel(request: TunnelRequest): Promise<TLSSocket> {
  const { proxy, host, port, alpn, timeoutMs, ca, signal } = request;
  const where = hostWithPort(proxy.host, proxy.port);
  const authority = hostWithPort(host, port);
  // Not Promise.withResolvers: that needs Node 22, and grokbot supports Node 20.3.
  let resolve!: (socket: TLSSocket) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<TLSSocket>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const proxySocket: Socket =
    proxy.scheme === "https"
      ? tlsConnect({
          host: proxy.host,
          port: proxy.port,
          servername: isIP(proxy.host) === 0 ? proxy.host : undefined,
          ...(ca === undefined ? {} : { ca }),
        })
      : netConnect({ host: proxy.host, port: proxy.port });
  let secure: TLSSocket | undefined;
  let settled = false;
  const finish = (error: unknown, socket?: TLSSocket) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    proxySocket.off("error", onProxyError);
    proxySocket.off("close", onClose);
    proxySocket.off("readable", onReadable);
    if (socket) {
      resolve(socket);
      return;
    }
    secure?.destroy();
    proxySocket.destroy();
    reject(error);
  };
  const fail = (problem: string) =>
    finish(new ProxyError(`${problem} ${GIVE_UP_HINT}`));
  const timer = setTimeout(
    () =>
      fail(
        `The proxy ${where} did not open a tunnel to ${authority} within ${Math.round(timeoutMs / 1000)} s.`,
      ),
    timeoutMs,
  );
  const onAbort = () => finish(signal?.reason);
  // Only the error code: a message can quote the address, never credentials, but
  // the code is all a reader needs.
  const onProxyError = (error: NodeJS.ErrnoException) =>
    fail(
      `Could not connect to the proxy ${where} (${error.code ?? "network error"}).`,
    );
  const onClose = () =>
    fail(
      `The proxy ${where} closed the connection before opening a tunnel to ${authority}.`,
    );
  let reply = Buffer.alloc(0);
  const onReadable = () => {
    for (
      let chunk = proxySocket.read() as Buffer | null;
      chunk !== null;
      chunk = proxySocket.read() as Buffer | null
    ) {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf("\r\n\r\n");
      if (end !== -1) {
        answered(
          reply.subarray(0, end).toString("latin1"),
          reply.subarray(end + 4),
        );
        return;
      }
      if (reply.length > MAX_REPLY_BYTES) {
        fail(`The proxy ${where} sent an oversized reply.`);
        return;
      }
    }
  };
  const answered = (head: string, rest: Buffer) => {
    const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head)?.[1]);
    if (status === 407) {
      fail(
        `The proxy ${where} requires authentication (HTTP 407) and ${proxy.authorization === undefined ? "the proxy URL has no credentials" : "rejected the credentials in the proxy URL"}.`,
      );
    } else if (!(status >= 200 && status < 300)) {
      fail(
        Number.isNaN(status)
          ? `The proxy ${where} sent a reply that is not HTTP.`
          : `The proxy ${where} refused the tunnel to ${authority} (HTTP ${status}).`,
      );
    } else if (rest.length > 0) {
      // A TLS server speaks only after the client hello, so bytes here are not a tunnel.
      fail(`The proxy ${where} sent data after the tunnel reply.`);
    } else {
      proxySocket.off("readable", onReadable);
      secureTunnel();
    }
  };
  const secureTunnel = () => {
    secure = tlsConnect({
      socket: proxySocket,
      host,
      servername: isIP(host) === 0 ? host : undefined,
      ALPNProtocols: [...alpn],
      ...(ca === undefined ? {} : { ca }),
    });
    secure.once("secureConnect", () => finish(undefined, secure));
    secure.once("error", (error: NodeJS.ErrnoException) =>
      fail(
        `TLS to ${host} through the proxy ${where} failed (${error.code ?? "TLS error"}). If the proxy inspects TLS traffic, trust its certificate authority with NODE_EXTRA_CA_CERTS.`,
      ),
    );
  };
  proxySocket.on("error", onProxyError);
  proxySocket.once("close", onClose);
  proxySocket.on("readable", onReadable);
  signal?.addEventListener("abort", onAbort, { once: true });
  proxySocket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: grokbot-core\r\n${proxy.authorization === undefined ? "" : `Proxy-Authorization: ${proxy.authorization}\r\n`}\r\n`,
  );
  return promise;
}
