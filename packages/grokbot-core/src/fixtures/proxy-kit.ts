import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The server name the test certificate is issued for. It resolves nowhere, so only a tunnel can reach it; the certificate also covers 127.0.0.1. */
export const TEST_HOST = "backend.test";

/** A throwaway self-signed certificate for TEST_HOST, made with the openssl binary. */
export async function selfSignedCert(): Promise<{
  readonly key: string;
  readonly cert: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "grokbot-proxy-cert-"));
  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "2",
      "-subj",
      `/CN=${TEST_HOST}`,
      "-addext",
      `subjectAltName=DNS:${TEST_HOST},IP:127.0.0.1`,
    ]);
    return {
      key: await readFile(join(dir, "key.pem"), "utf8"),
      cert: await readFile(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Resolves once `server` listens on a free loopback port. */
async function listening(server: Http2SecureServer | Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
}

/** Closes `server` after destroying its open sockets. */
async function shutDown(
  server: Http2SecureServer | Server,
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  for (const socket of sockets) socket.destroy();
  server.close(() => resolve());
  await promise;
}

export interface SeenRequest {
  readonly httpVersion: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/** What a test handler uses of an HTTP/1.1 or HTTP/2 response. */
export interface BackendResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

/** A local TLS server speaking HTTP/2 and HTTP/1.1, answering with `respond`. */
export async function tlsBackend(
  credentials: { readonly key: string; readonly cert: string },
  respond: (seen: SeenRequest, res: BackendResponse) => void,
  /** `http1`: a server that does not offer HTTP/2, like some TLS-inspecting proxies. Default: both. */
  protocol: "both" | "http1" = "both",
): Promise<{
  readonly port: number;
  readonly requests: SeenRequest[];
  close(): Promise<void>;
}> {
  const requests: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  const server =
    protocol === "http1"
      ? createHttpsServer(credentials)
      : createSecureServer({ ...credentials, allowHTTP1: true });
  server.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
    });
    req.on("end", () => {
      const seen = {
        httpVersion: req.httpVersion,
        method: req.method,
        path: req.url,
        body,
      };
      requests.push(seen);
      respond(seen, res);
    });
  });
  await listening(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return {
    port: address.port,
    requests,
    close: () => shutDown(server, sockets),
  };
}

export interface ConnectProxyOptions {
  /** Where every tunnel really goes, whatever name the client asked for. */
  readonly upstreamPort: number;
  /** Answer 407 unless the client sends exactly this Proxy-Authorization. */
  readonly requireAuthorization?: string;
  /** Answer this status instead of opening a tunnel. */
  readonly refuseWith?: number;
  /** Accept the CONNECT and never answer it. */
  readonly silent?: boolean;
  /** Serve the proxy itself over TLS with this certificate (an https:// proxy URL). */
  readonly tls?: { readonly key: string; readonly cert: string };
}

export interface ConnectRequest {
  readonly authority: string;
  readonly authorization: string | undefined;
}

/** A minimal HTTP CONNECT proxy on a free loopback port that records what clients ask. */
export async function connectProxy(options: ConnectProxyOptions): Promise<{
  readonly port: number;
  readonly requests: ConnectRequest[];
  /** Resets every open connection, as a proxy that crashes does. */
  reset(): void;
  close(): Promise<void>;
}> {
  const requests: ConnectRequest[] = [];
  const sockets = new Set<Socket>();
  const onClient = (client: Socket) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      answer(head.subarray(0, end).toString("latin1"));
    };
    const refuse = (status: number, reason: string) => {
      client.end(
        `HTTP/1.1 ${status} ${reason}\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    };
    const answer = (text: string) => {
      const [requestLine = "", ...lines] = text.split("\r\n");
      const authorization = lines
        .find((line) => line.toLowerCase().startsWith("proxy-authorization:"))
        ?.slice("proxy-authorization:".length)
        .trim();
      requests.push({
        authority: requestLine.split(" ")[1] ?? "",
        authorization,
      });
      if (
        options.requireAuthorization !== undefined &&
        authorization !== options.requireAuthorization
      ) {
        refuse(407, "Proxy Authentication Required");
        return;
      }
      if (options.silent) return;
      if (options.refuseWith !== undefined) {
        refuse(options.refuseWith, "Refused");
        return;
      }
      const upstream = connect({
        host: "127.0.0.1",
        port: options.upstreamPort,
      });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  };
  const server: Server = options.tls
    ? createTlsServer(options.tls, onClient)
    : createServer(onClient);
  await listening(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return {
    port: address.port,
    requests,
    reset: () => {
      for (const socket of sockets) socket.resetAndDestroy();
    },
    close: () => shutDown(server, sockets),
  };
}
