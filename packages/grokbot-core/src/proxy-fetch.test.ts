import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  type ConnectProxyOptions,
  connectProxy,
  selfSignedCert,
  TEST_HOST,
  tlsBackend,
} from "./fixtures/proxy-kit.js";
import { createBackendFetch, createProxyFetch } from "./network-fetch.js";

type Credentials = Awaited<ReturnType<typeof selfSignedCert>>;
let credentials: Credentials;
beforeAll(async () => {
  credentials = await selfSignedCert();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});

/** A TLS backend plus a CONNECT proxy in front of it, both on loopback. */
async function world(
  proxyOptions: Omit<ConnectProxyOptions, "upstreamPort"> = {},
  respond: Parameters<typeof tlsBackend>[1] = (seen, res) => {
    if (seen.path === "/redirect") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${seen.httpVersion} ${seen.method} ${seen.path} ${seen.body}`);
  },
  protocol: Parameters<typeof tlsBackend>[2] = "both",
) {
  const backend = await tlsBackend(credentials, respond, protocol);
  const proxy = await connectProxy({
    upstreamPort: backend.port,
    ...proxyOptions,
  });
  cleanups.push(backend.close, proxy.close);
  return {
    backend,
    proxy,
    origin: `https://${TEST_HOST}:${backend.port}`,
    authority: `${TEST_HOST}:${backend.port}`,
    env: (url: string) => ({ GROKBOT_HTTPS_PROXY: url }),
  };
}

const textOf = async (response: Response) => response.text();

describe("backend HTTP/2 through a CONNECT proxy", () => {
  it("tunnels to the real host, keeps HTTP/2 and reuses one connection", async () => {
    const w = await world();
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    const first = await fetch(`${w.origin}/one`, {
      method: "POST",
      body: "hello",
    });
    expect(first.status).toBe(200);
    expect(await textOf(first)).toBe("2.0 POST /one hello");
    const [second, third] = await Promise.all([
      fetch(`${w.origin}/two`, { method: "POST", body: "a" }).then(textOf),
      fetch(`${w.origin}/three`, { method: "POST", body: "b" }).then(textOf),
    ]);
    expect(second).toBe("2.0 POST /two a");
    expect(third).toBe("2.0 POST /three b");
    expect(w.proxy.requests).toEqual([
      { authority: w.authority, authorization: undefined },
    ]);
  });

  it("streams a response through the tunnel as it arrives", async () => {
    const release = Promise.withResolvers<void>();
    const w = await world({}, (_seen, res) => {
      res.writeHead(200);
      res.write("first");
      release.promise.then(() => res.end("second"));
    });
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    const response = await fetch(`${w.origin}/stream`, { method: "POST" });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    // The server holds the rest back until this chunk is read, so it arrived as it was sent.
    const head = await reader.read();
    expect(new TextDecoder().decode(head.value)).toBe("first");
    release.resolve();
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toBe("second");
  });

  it("sends Proxy-Authorization only when the proxy URL has credentials", async () => {
    const expected = `Basic ${Buffer.from("user:p@ss").toString("base64")}`;
    const w = await world({ requireAuthorization: expected });
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://user:p%40ss@127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    expect(await textOf(await fetch(`${w.origin}/a`, { method: "POST" }))).toBe(
      "2.0 POST /a ",
    );
    expect(w.proxy.requests).toEqual([
      { authority: w.authority, authorization: expected },
    ]);

    const open = await world();
    const direct = createBackendFetch(open.origin, {
      env: open.env(`http://127.0.0.1:${open.proxy.port}`),
      ca: credentials.cert,
    });
    await textOf(await direct(`${open.origin}/a`, { method: "POST" }));
    expect(open.proxy.requests[0]?.authorization).toBeUndefined();
  });

  it("maps a 407 to an error naming only the proxy host:port", async () => {
    const w = await world({
      requireAuthorization: "Basic right",
    });
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://user:topsecret@127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    const error = await fetch(`${w.origin}/a`, { method: "POST" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GrokBotError);
    const { message } = error as GrokBotError;
    expect(message).toContain(`127.0.0.1:${w.proxy.port}`);
    expect(message).toContain("407");
    expect(message).toContain("GROKBOT_HTTPS_PROXY=off");
    expect(message).not.toMatch(/topsecret|user:|Basic/);
    // A failed tunnel is not kept: the next call tries again.
    const again = await fetch(`${w.origin}/a`, { method: "POST" }).catch(
      (e: unknown) => e,
    );
    expect(again).toBeInstanceOf(GrokBotError);
    expect(w.proxy.requests).toHaveLength(2);
  });

  it("maps another refusal and a closed proxy port to the same kind of error", async () => {
    const refused = await world({ refuseWith: 403 });
    const blocked = await createBackendFetch(refused.origin, {
      env: refused.env(`http://127.0.0.1:${refused.proxy.port}`),
      ca: credentials.cert,
    })(`${refused.origin}/a`, { method: "POST" }).catch((e: unknown) => e);
    expect((blocked as GrokBotError).message).toContain("HTTP 403");
    expect((blocked as GrokBotError).message).toContain(
      `127.0.0.1:${refused.proxy.port}`,
    );

    const gone = await world();
    await gone.proxy.close();
    const closed = await createBackendFetch(gone.origin, {
      env: gone.env(`http://127.0.0.1:${gone.proxy.port}`),
      ca: credentials.cert,
    })(`${gone.origin}/a`, { method: "POST" }).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(GrokBotError);
    expect((closed as GrokBotError).message).toContain(
      `127.0.0.1:${gone.proxy.port}`,
    );
    expect((closed as GrokBotError).message).toContain(
      "GROKBOT_HTTPS_PROXY=off",
    );
  });

  it("fails the TLS check for a server whose certificate is not trusted", async () => {
    const w = await world();
    const error = await createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
    })(`${w.origin}/a`, { method: "POST" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).toContain("TLS");
  });

  it("stops waiting for the tunnel when the caller aborts", async () => {
    const w = await world();
    const controller = new AbortController();
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    const pending = fetch(`${w.origin}/a`, {
      method: "POST",
      signal: controller.signal,
    });
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });

  it("connects directly when no proxy is configured", async () => {
    const w = await world();
    const origin = `https://127.0.0.1:${w.backend.port}`;
    const fetch = createBackendFetch(origin, { env: {}, ca: credentials.cert });
    expect(await textOf(await fetch(`${origin}/a`, { method: "POST" }))).toBe(
      "2.0 POST /a ",
    );
    expect(w.proxy.requests).toEqual([]);
  });

  it("works through an https:// proxy", async () => {
    const backend = await world();
    const proxy = await connectProxy({
      upstreamPort: backend.backend.port,
      tls: credentials,
    });
    cleanups.push(proxy.close);
    const fetch = createBackendFetch(backend.origin, {
      env: { HTTPS_PROXY: `https://127.0.0.1:${proxy.port}` },
      ca: credentials.cert,
    });
    expect(
      await textOf(await fetch(`${backend.origin}/a`, { method: "POST" })),
    ).toBe("2.0 POST /a ");
    expect(proxy.requests.map((r) => r.authority)).toEqual([backend.authority]);
  });

  it("falls back to HTTP/1.1 over the tunnel when the server will not speak HTTP/2", async () => {
    const w = await world(undefined, undefined, "http1");
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    expect(
      await textOf(await fetch(`${w.origin}/a`, { method: "POST", body: "x" })),
    ).toBe("1.1 POST /a x");
    expect(
      await textOf(await fetch(`${w.origin}/b`, { method: "POST", body: "y" })),
    ).toBe("1.1 POST /b y");
  });

  it("opens a new tunnel after the proxy resets the connection", async () => {
    const w = await world();
    const fetch = createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    await textOf(await fetch(`${w.origin}/a`, { method: "POST" }));
    w.proxy.reset();
    // The dead session may fail the call that lands on it once; the next one is fresh.
    await fetch(`${w.origin}/b`, { method: "POST" })
      .then(textOf)
      .catch(() => undefined);
    expect(await textOf(await fetch(`${w.origin}/c`, { method: "POST" }))).toBe(
      "2.0 POST /c ",
    );
    expect(w.proxy.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("never sends loopback through the proxy, even when one is configured", async () => {
    const w = await world();
    const origin = `https://127.0.0.1:${w.backend.port}`;
    const fetch = createBackendFetch(origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    expect(await textOf(await fetch(`${origin}/a`, { method: "POST" }))).toBe(
      "2.0 POST /a ",
    );
    expect(w.proxy.requests).toEqual([]);
  });

  it("fails with the proxy error when the proxy accepts the connection and never answers", async () => {
    const w = await world({ silent: true });
    const error = await createBackendFetch(w.origin, {
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
      // The deadline under test: a genuine timer in the code, so keep it short.
      connectTimeoutMs: 100,
    })(`${w.origin}/a`, { method: "POST" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).toContain(
      `127.0.0.1:${w.proxy.port}`,
    );
    expect((error as GrokBotError).message).toContain(
      "GROKBOT_HTTPS_PROXY=off",
    );
  });
});

describe("other https calls through a CONNECT proxy", () => {
  it("tunnels an HTTP/1.1 GET and POST", async () => {
    const w = await world();
    const fetch = createProxyFetch({
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    expect(
      await textOf(await fetch(`${w.origin}/blob?x=1`, { method: "GET" })),
    ).toBe("1.1 GET /blob?x=1 ");
    expect(
      await textOf(
        await fetch(`${w.origin}/post`, {
          method: "POST",
          body: "payload",
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe("1.1 POST /post payload");
    expect(w.proxy.requests.map((r) => r.authority)).toEqual([
      w.authority,
      w.authority,
    ]);
  });

  it("sends Proxy-Authorization and follows a redirect", async () => {
    const expected = `Basic ${Buffer.from("user:pw").toString("base64")}`;
    const w = await world({ requireAuthorization: expected });
    const fetch = createProxyFetch({
      env: w.env(`http://user:pw@127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    });
    expect(
      await textOf(await fetch(`${w.origin}/redirect`, { method: "GET" })),
    ).toBe("1.1 GET /final ");
    expect(w.proxy.requests.every((r) => r.authorization === expected)).toBe(
      true,
    );
  });

  it("maps a 407 to the proxy error", async () => {
    const w = await world({ requireAuthorization: "Basic right" });
    const error = await createProxyFetch({
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    })(`${w.origin}/a`, { method: "GET" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).toContain(
      `127.0.0.1:${w.proxy.port}`,
    );
    expect((error as GrokBotError).message).toContain("407");
  });

  it("aborts a tunnelled request with the caller's reason", async () => {
    const arrived = Promise.withResolvers<void>();
    const w = await world({}, () => {
      // Never answers; the caller aborts once the request is there.
      arrived.resolve();
    });
    const controller = new AbortController();
    const pending = createProxyFetch({
      env: w.env(`http://127.0.0.1:${w.proxy.port}`),
      ca: credentials.cert,
    })(`${w.origin}/hang`, { method: "GET", signal: controller.signal });
    await arrived.promise;
    controller.abort(new Error("enough"));
    await expect(pending).rejects.toThrow("enough");
  });

  it("is plain global fetch when no proxy is configured", async () => {
    const reply = new Response("direct");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply);
    const init = { method: "GET" } as const;
    const response = await createProxyFetch({ env: {} })(
      "https://api2.cursor.sh/x",
      init,
    );
    expect(response).toBe(reply);
    expect(spy).toHaveBeenCalledWith("https://api2.cursor.sh/x", init);
  });

  it("is plain global fetch for a NO_PROXY host", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("direct"));
    await createProxyFetch({
      env: { HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "cursor.sh" },
    })("https://api2.cursor.sh/x", { method: "GET" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports a malformed proxy setting without echoing it", async () => {
    const error = await createProxyFetch({
      env: { HTTPS_PROXY: "socks5://user:secret@127.0.0.1:1080" },
    })("https://api2.cursor.sh/x", { method: "GET" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokBotError);
    expect((error as GrokBotError).message).not.toContain("secret");
  });
});
