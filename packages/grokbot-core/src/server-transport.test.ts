import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { createServerTransport } from "./server-transport.js";

const TOKEN = "synthetic-token-7f3a";
const URL_BASE = "https://api2.cursor.sh/aiserver.v1.GrokBotService";

interface SeenRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Responder = (
  request: SeenRequest,
  signal: AbortSignal | undefined,
) => Response | Promise<Response>;

function fakeFetch(respond: Responder) {
  const requests: SeenRequest[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const request = {
      url,
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body,
    };
    requests.push(request);
    return respond(request, init.signal ?? undefined);
  };
  return { fetch, requests };
}

function hangUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

const ascii = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0));
const frame = (flag: number, json: string): number[] => [
  flag,
  0,
  0,
  0,
  json.length,
  ...ascii(json),
];

function streamResponse(chunks: number[][], signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      if (signal) {
        signal.addEventListener("abort", () => controller.error(signal.reason));
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const transportWith = (respond: Responder) => {
  const fake = fakeFetch(respond);
  const transport = createServerTransport({
    getToken: async () => TOKEN,
    fetch: fake.fetch,
  });
  return { transport, requests: fake.requests };
};

describe("ServerTransport.call", () => {
  it("POSTs JSON with the token only in authorization", async () => {
    const { transport, requests } = transportWith(() =>
      Response.json({ agents: [{ name: "Primary Test" }] }),
    );
    const result = await transport.call("ListGrokBotAgents", { limit: 5 });
    expect(result).toEqual({ agents: [{ name: "Primary Test" }] });
    expect(requests).toEqual([
      {
        url: `${URL_BASE}/ListGrokBotAgents`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          origin: "https://cursor.com",
          "user-agent": "grokbot-core",
        },
        body: '{"limit":5}',
      },
    ]);
  });

  it("uses a custom base URL and user agent", async () => {
    const fake = fakeFetch(() => Response.json({}));
    const transport = createServerTransport({
      getToken: async () => TOKEN,
      fetch: fake.fetch,
      baseUrl: "https://staging.example",
      userAgent: "host-app/2",
    });
    await transport.call("ListGrokBotAgents", {});
    expect(fake.requests.map((r) => [r.url, r.headers["user-agent"]])).toEqual([
      [
        "https://staging.example/aiserver.v1.GrokBotService/ListGrokBotAgents",
        "host-app/2",
      ],
    ]);
  });

  it("returns {} for an empty body", async () => {
    const { transport } = transportWith(
      () => new Response("", { status: 200 }),
    );
    expect(await transport.call("ListGrokBotAgents", {})).toEqual({});
  });

  it("reads a fresh token for every call", async () => {
    const tokens = ["synthetic-a", "synthetic-b"];
    const fake = fakeFetch(() => Response.json({}));
    const transport = createServerTransport({
      getToken: async () => tokens.shift() ?? "",
      fetch: fake.fetch,
    });
    await transport.call("ListGrokBotAgents", {});
    await transport.call("ListGrokBotAgents", {});
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer synthetic-a",
      "Bearer synthetic-b",
    ]);
  });

  it.each([401, 403])("maps HTTP %i to an auth error", async (status) => {
    const { transport } = transportWith(
      () => new Response('{"code":"unauthenticated"}', { status }),
    );
    await expect(transport.call("ListGrokBotAgents", {})).rejects.toEqual(
      new GrokBotError(
        "auth",
        `ListGrokBotAgents was rejected with HTTP ${status}: {"code":"unauthenticated"}. If the login is stale, run grokbot login or open the Grok Bot app once to refresh it.`,
      ),
    );
  });

  it("maps other failures to an http error with 300 body chars", async () => {
    const { transport } = transportWith(
      () => new Response(`${"x".repeat(300)}TAIL`, { status: 502 }),
    );
    await expect(transport.call("ListGrokBotAgents", {})).rejects.toEqual(
      new GrokBotError(
        "http",
        `ListGrokBotAgents failed with HTTP 502: ${"x".repeat(300)}`,
      ),
    );
  });

  it("rejects a success body that is not JSON", async () => {
    const { transport } = transportWith(() => new Response("<html>"));
    await expect(transport.call("ListGrokBotAgents", {})).rejects.toEqual(
      new GrokBotError(
        "protocol",
        "ListGrokBotAgents returned a non-JSON body.",
      ),
    );
  });

  it("reports a network failure", async () => {
    const { transport } = transportWith(() => {
      throw new TypeError("fetch failed");
    });
    await expect(transport.call("ListGrokBotAgents", {})).rejects.toEqual(
      new GrokBotError(
        "http",
        "ListGrokBotAgents request failed on the network.",
      ),
    );
  });

  it("blocks a destructive method unless confirmed", async () => {
    const { transport, requests } = transportWith(() => Response.json({}));
    await expect(
      transport.call("DeleteGrokBotAgent", { agentId: "a" }),
    ).rejects.toEqual(
      new GrokBotError(
        "safety",
        "DeleteGrokBotAgent is tagged destructive. Pass confirmed: true only after the owner approves.",
      ),
    );
    expect(requests).toEqual([]);
    await transport.call("DeleteGrokBotAgent", {}, { confirmed: true });
    expect(requests.map((r) => r.url)).toEqual([
      `${URL_BASE}/DeleteGrokBotAgent`,
    ]);
  });

  it("times out after timeoutMs", async () => {
    const { transport } = transportWith((_, signal) =>
      hangUntilAborted(signal),
    );
    await expect(
      transport.call("ListGrokBotAgents", {}, { timeoutMs: 20 }),
    ).rejects.toEqual(
      new GrokBotError("timeout", "ListGrokBotAgents timed out after 20 ms."),
    );
  });

  it("rejects with the caller's abort reason", async () => {
    const { transport } = transportWith((_, signal) =>
      hangUntilAborted(signal),
    );
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const pending = transport.call(
      "ListGrokBotAgents",
      {},
      { signal: controller.signal },
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("ServerTransport.stream", () => {
  const body = { cursors: [] };

  it("POSTs one Connect envelope with the stream headers", async () => {
    const { transport, requests } = transportWith(() =>
      streamResponse([frame(2, "{}")]),
    );
    await collect(transport.stream("WatchGrokBotTranscripts", { a: 1 }));
    expect(requests).toEqual([
      {
        url: `${URL_BASE}/WatchGrokBotTranscripts`,
        method: "POST",
        headers: {
          "content-type": "application/connect+json",
          "connect-protocol-version": "1",
          authorization: `Bearer ${TOKEN}`,
          origin: "https://cursor.com",
          "user-agent": "grokbot-core",
        },
        body: new Uint8Array(frame(0, '{"a":1}')),
      },
    ]);
  });

  it("yields each message across chunk boundaries until the trailer", async () => {
    const bytes = [
      ...frame(0, '{"type":"connected"}'),
      ...frame(0, '{"type":"heartbeat"}'),
      ...frame(2, "{}"),
    ];
    const { transport } = transportWith(() =>
      streamResponse([bytes.slice(0, 7), bytes.slice(7, 30), bytes.slice(30)]),
    );
    expect(
      await collect(transport.stream("WatchGrokBotTranscripts", body)),
    ).toEqual([{ type: "connected" }, { type: "heartbeat" }]);
  });

  it("throws a protocol error for an end-stream error", async () => {
    const { transport } = transportWith(() =>
      streamResponse([
        frame(0, '{"type":"connected"}'),
        frame(2, '{"error":{"code":"unavailable","message":"box asleep"}}'),
      ]),
    );
    await expect(
      collect(transport.stream("WatchGrokBotTranscripts", body)),
    ).rejects.toEqual(
      new GrokBotError(
        "protocol",
        "WatchGrokBotTranscripts stream ended with unavailable: box asleep",
      ),
    );
  });

  it("throws when the body closes without a trailer", async () => {
    const { transport } = transportWith(() =>
      streamResponse([frame(0, '{"type":"connected"}')]),
    );
    await expect(
      collect(transport.stream("WatchGrokBotTranscripts", body)),
    ).rejects.toEqual(
      new GrokBotError(
        "protocol",
        "WatchGrokBotTranscripts stream closed without an end-of-stream frame.",
      ),
    );
  });

  it("stops cleanly when the caller aborts", async () => {
    const { transport } = transportWith((_, signal) =>
      streamResponse([frame(0, '{"type":"connected"}')], signal),
    );
    const controller = new AbortController();
    const seen: unknown[] = [];
    for await (const message of transport.stream(
      "WatchGrokBotTranscripts",
      body,
      { signal: controller.signal },
    )) {
      seen.push(message);
      controller.abort();
    }
    expect(seen).toEqual([{ type: "connected" }]);
  });

  it("maps HTTP 401 to an auth error", async () => {
    const { transport } = transportWith(
      () => new Response("", { status: 401 }),
    );
    await expect(
      collect(transport.stream("WatchGrokBotTranscripts", body)),
    ).rejects.toEqual(
      new GrokBotError(
        "auth",
        "WatchGrokBotTranscripts was rejected with HTTP 401. If the login is stale, run grokbot login or open the Grok Bot app once to refresh it.",
      ),
    );
  });

  it("reads the token when iteration starts and passes its error through", async () => {
    const reads: string[] = [];
    const transport = createServerTransport({
      getToken: async () => {
        reads.push("read");
        throw new GrokBotError("auth", "Keychain locked.");
      },
      fetch: async () => streamResponse([]),
    });
    const iterable = transport.stream("WatchGrokBotTranscripts", body);
    expect(reads).toEqual([]);
    await expect(collect(iterable)).rejects.toEqual(
      new GrokBotError("auth", "Keychain locked."),
    );
    expect(reads).toEqual(["read"]);
  });

  it("blocks a sensitive stream before any request", async () => {
    const { transport, requests } = transportWith(() => streamResponse([]));
    expect(() =>
      transport.stream("WatchGrokBotUserComputerRequests", body),
    ).toThrow(
      new GrokBotError(
        "safety",
        "WatchGrokBotUserComputerRequests is tagged sensitive. Pass confirmed: true only after the owner approves.",
      ),
    );
    expect(requests).toEqual([]);
  });
});

describe("BackgroundComposerService transport", () => {
  const COMPOSER_URL =
    "https://api2.cursor.sh/aiserver.v1.BackgroundComposerService";
  const composerTransport = (respond: Responder) => {
    const fake = fakeFetch(respond);
    const transport = createServerTransport({
      getToken: async () => TOKEN,
      fetch: fake.fetch,
      service: "BackgroundComposerService",
    });
    return { transport, requests: fake.requests };
  };

  it("posts a unary read and a stream to its own service path", async () => {
    const { transport, requests } = composerTransport((request) =>
      request.url.endsWith("/StreamBackgroundComposerUpdates")
        ? streamResponse([frame(0, '{"snapshot":{}}'), frame(2, "{}")])
        : Response.json({ composer: {} }),
    );
    await transport.call("GetBackgroundComposerInfo", { bcId: "bc-1" });
    const frames = await collect(
      transport.stream("StreamBackgroundComposerUpdates", { snapshotN: 5 }),
    );
    expect([frames, requests.map((r) => r.url)]).toEqual([
      [{ snapshot: {} }],
      [
        `${COMPOSER_URL}/GetBackgroundComposerInfo`,
        `${COMPOSER_URL}/StreamBackgroundComposerUpdates`,
      ],
    ]);
  });

  it("refuses a method outside its table before any request, including a GrokBotService one", async () => {
    const { transport, requests } = composerTransport(() => Response.json({}));
    // `call` rejects; `stream` throws on the spot.
    await expect(
      transport.call("GetBackgroundComposerArtifact", { bcId: "bc-1" }),
    ).rejects.toMatchObject({ code: "safety" });
    await expect(
      transport.call("DeleteGrokBotAgent", { agentId: "a" }),
    ).rejects.toMatchObject({ code: "safety" });
    expect(() => transport.stream("WatchGrokBotTranscripts", {})).toThrow(
      expect.objectContaining({ code: "safety" }),
    );
    expect(requests).toEqual([]);
  });

  it("lets the GrokBotService transport keep refusing a composer method", async () => {
    const { transport, requests } = transportWith(() => Response.json({}));
    await expect(
      transport.call("GetBackgroundComposerInfo", { bcId: "bc-1" }),
    ).rejects.toMatchObject({ code: "safety" });
    expect(requests).toEqual([]);
  });
});

describe("token redaction", () => {
  it("keeps the token out of every error message, even when echoed", async () => {
    const echo: Responder = (request) =>
      new Response(`echo ${request.headers.authorization}`, { status: 500 });
    const echoAuth: Responder = (request) =>
      new Response(`echo ${request.headers.authorization}`, { status: 401 });
    const echoTrailer: Responder = () =>
      streamResponse([
        frame(2, `{"error":{"code":"internal","message":"bad ${TOKEN}"}}`),
      ]);

    const messages: string[] = [];
    for (const respond of [echo, echoAuth]) {
      const { transport } = transportWith(respond);
      await transport
        .call("ListGrokBotAgents", {})
        .catch((error: Error) => messages.push(error.message));
    }
    const { transport } = transportWith(echoTrailer);
    await collect(transport.stream("WatchGrokBotTranscripts", {})).catch(
      (error: Error) => messages.push(error.message),
    );

    expect(messages).toEqual([
      "ListGrokBotAgents failed with HTTP 500: echo Bearer [redacted]",
      "ListGrokBotAgents was rejected with HTTP 401: echo Bearer [redacted]. If the login is stale, run grokbot login or open the Grok Bot app once to refresh it.",
      "WatchGrokBotTranscripts stream ended with internal: bad [redacted]",
    ]);
  });
});
