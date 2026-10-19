import {
  constants,
  createServer,
  type Http2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createHttp2Fetch } from "./http2-fetch.js";

type Handler = (
  stream: ServerHttp2Stream,
  headers: Record<string, unknown>,
) => void;

/** A cleartext HTTP/2 server on a free port that counts connections. */
async function h2Server(handle: Handler) {
  const server: Http2Server = createServer();
  const sessions: ServerHttp2Session[] = [];
  server.on("session", (session) => sessions.push(session));
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    // A server's streams are ServerHttp2Streams; the event typings name the base class.
    handle(stream as ServerHttp2Stream, headers);
  });
  await new Promise<void>((done) => server.listen(0, done));
  const { port } = server.address() as AddressInfo;
  servers.push({ server, sessions });
  return { origin: `http://localhost:${port}`, sessions };
}

const servers: { server: Http2Server; sessions: ServerHttp2Session[] }[] = [];
afterEach(async () => {
  for (const { server, sessions } of servers.splice(0)) {
    for (const session of sessions) session.destroy();
    await new Promise((done) => server.close(done));
  }
});

const echo: Handler = (stream, headers) => {
  let body = "";
  stream.on("data", (chunk) => {
    body += chunk;
  });
  stream.on("end", () => {
    stream.respond({ ":status": 200, "x-seen": String(headers.origin) });
    stream.end(`${headers[":method"]} ${headers[":path"]} ${body}`);
  });
};

const post = (body: string, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { origin: "https://example.com", "content-type": "text/plain" },
  body,
  ...(signal && { signal }),
});

describe("createHttp2Fetch", () => {
  it("sends method, path, headers and body, and returns status, headers and text", async () => {
    const { origin } = await h2Server(echo);
    const response = await createHttp2Fetch()(`${origin}/a/B?x=1`, post("hi"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-seen")).toBe("https://example.com");
    expect(await response.text()).toBe("POST /a/B?x=1 hi");
  });

  it("runs calls made together over one connection", async () => {
    const { origin, sessions } = await h2Server(echo);
    const fetch = createHttp2Fetch();
    const texts = await Promise.all(
      ["1", "2", "3"].map(async (n) => (await fetch(origin, post(n))).text()),
    );
    expect(texts).toStrictEqual(["POST / 1", "POST / 2", "POST / 3"]);
    expect(sessions).toHaveLength(1);
  });

  it("hands over streamed chunks as they arrive", async () => {
    const { origin } = await h2Server((stream) => {
      stream.respond({ ":status": 200 });
      stream.write("one;");
      setTimeout(() => stream.end("two"), 20);
    });
    const response = await createHttp2Fetch()(origin, post(""));
    const chunks: string[] = [];
    for await (const chunk of response.body ?? []) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    expect(chunks).toStrictEqual(["one;", "two"]);
  });

  it("rejects a body read when aborted mid-stream, and cancels it on the server", async () => {
    let serverClosed: Promise<number> = Promise.resolve(-1);
    const { origin } = await h2Server((stream) => {
      serverClosed = new Promise((done) =>
        stream.once("close", () => done(stream.rstCode ?? -1)),
      );
      stream.respond({ ":status": 200 });
      stream.write("first");
    });
    const controller = new AbortController();
    const response = await createHttp2Fetch()(
      origin,
      post("", controller.signal),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort(new Error("stop"));
    await expect(reader.read()).rejects.toThrow("stop");
    expect(await serverClosed).toBe(constants.NGHTTP2_CANCEL);
  });

  it("rejects the call when aborted before the response", async () => {
    const { origin } = await h2Server(() => {});
    const controller = new AbortController();
    const call = createHttp2Fetch()(origin, post("", controller.signal));
    setTimeout(() => controller.abort(new Error("gave up")), 10);
    await expect(call).rejects.toThrow("gave up");
  });

  it("asks for compression and decodes gzip and br bodies", async () => {
    const encoders = { gzip: gzipSync, br: brotliCompressSync };
    const { origin } = await h2Server((stream, headers) => {
      const name = headers[":path"] === "/br" ? "br" : "gzip";
      stream.respond({ ":status": 200, "content-encoding": name });
      stream.end(encoders[name](`${name} for ${headers["accept-encoding"]}`));
    });
    const fetch = createHttp2Fetch();
    expect(await (await fetch(`${origin}/gz`, post(""))).text()).toBe(
      "gzip for gzip, deflate, br",
    );
    expect(await (await fetch(`${origin}/br`, post(""))).text()).toBe(
      "br for gzip, deflate, br",
    );
  });

  it("rejects a compressed body read when aborted mid-stream", async () => {
    const { origin } = await h2Server((stream) => {
      stream.respond({ ":status": 200, "content-encoding": "gzip" });
      stream.write(gzipSync("x".repeat(100)).subarray(0, 10));
    });
    const controller = new AbortController();
    const response = await createHttp2Fetch()(
      origin,
      post("", controller.signal),
    );
    setTimeout(() => controller.abort(new Error("stop")), 20);
    await expect(response.text()).rejects.toThrow("stop");
  });

  it("returns a null body for 204", async () => {
    const { origin } = await h2Server((stream) =>
      stream.respond({ ":status": 204 }, { endStream: true }),
    );
    const response = await createHttp2Fetch()(origin, post(""));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("opens a new connection after the server sends GOAWAY", async () => {
    const { origin, sessions } = await h2Server(echo);
    const fetch = createHttp2Fetch();
    await (await fetch(origin, post("a"))).text();
    sessions[0]?.goaway();
    await new Promise((done) => setTimeout(done, 20));
    expect(await (await fetch(origin, post("b"))).text()).toBe("POST / b");
    expect(sessions).toHaveLength(2);
  });

  it("closes a connection left idle", async () => {
    const { origin, sessions } = await h2Server(echo);
    await (
      await createHttp2Fetch({ idleCloseMs: 20 })(origin, post(""))
    ).text();
    await new Promise((done) => sessions[0]?.once("close", done));
    expect(sessions[0]?.closed).toBe(true);
  });

  it("rejects when nothing listens", async () => {
    const { origin } = await h2Server(echo);
    await new Promise((done) => servers.pop()?.server.close(done));
    await expect(createHttp2Fetch()(origin, post(""))).rejects.toThrow();
  });

  it("fails a response that stays silent", async () => {
    const { origin } = await h2Server((stream) =>
      stream.respond({ ":status": 200 }),
    );
    const response = await createHttp2Fetch({ silenceTimeoutMs: 30 })(
      origin,
      post(""),
    );
    await expect(response.text()).rejects.toThrow("silent for 30 ms");
  });
});
