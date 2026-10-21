import { describe, expect, it } from "vitest";
import {
  type CallOptions,
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { createGatewayTransport } from "./gateway-transport.js";

const GATEWAY_URL = "https://box-synthetic.example";

interface SeenRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeServer(sandboxes: JsonObject[]) {
  const ensures: [string, JsonObject, CallOptions | undefined][] = [];
  const server: ServerTransport = {
    async call(method, body, options) {
      ensures.push([method, body, options]);
      const next = sandboxes.shift();
      if (next === undefined) throw new Error("no more sandboxes");
      return next;
    },
    stream() {
      throw new Error("stream is not used by the gateway");
    },
  };
  return { server, ensures };
}

const sandbox = (n: number) => ({
  gatewayUrl: `${GATEWAY_URL}/`,
  gatewayToken: `synthetic-gateway-${n}`,
  networkToken: `synthetic-network-${n}`,
  vncUrl: "https://vnc.example",
});

function fakeFetch(statuses: number[]) {
  const requests: SeenRequest[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body,
    });
    const status = statuses.shift() ?? 200;
    return status === 200
      ? Response.json({ agents: [{ name: "Primary Test" }] })
      : new Response("expired", { status });
  };
  return { fetch, requests };
}

describe("GatewayTransport.call", () => {
  it("ensures the sandbox once and POSTs with both gateway tokens", async () => {
    const { server, ensures } = fakeServer([sandbox(1)]);
    const { fetch, requests } = fakeFetch([]);
    const gateway = createGatewayTransport({ server, fetch });

    const first = await gateway.call("listAgents", {});
    await gateway.call("getMcpState", { agentId: "a" });

    expect(first).toEqual({ agents: [{ name: "Primary Test" }] });
    expect(ensures).toEqual([["EnsureSandBox", {}, undefined]]);
    expect(requests).toEqual([
      {
        url: `${GATEWAY_URL}/api/listAgents`,
        headers: {
          authorization: "Bearer synthetic-gateway-1",
          "x-anyrun-network-token": "synthetic-network-1",
          "content-type": "application/json",
        },
        body: "{}",
      },
      {
        url: `${GATEWAY_URL}/api/getMcpState`,
        headers: {
          authorization: "Bearer synthetic-gateway-1",
          "x-anyrun-network-token": "synthetic-network-1",
          "content-type": "application/json",
        },
        body: '{"agentId":"a"}',
      },
    ]);
  });

  it("shares one EnsureSandBox between concurrent first calls", async () => {
    const { server, ensures } = fakeServer([sandbox(1)]);
    const { fetch } = fakeFetch([]);
    const gateway = createGatewayTransport({ server, fetch });
    await Promise.all([
      gateway.call("listAgents", {}),
      gateway.call("listAgents", {}),
    ]);
    expect(ensures.length).toBe(1);
  });

  it.each([401, 403])(
    "re-ensures once and retries after HTTP %i",
    async (status) => {
      const { server, ensures } = fakeServer([sandbox(1), sandbox(2)]);
      const { fetch, requests } = fakeFetch([status]);
      const gateway = createGatewayTransport({ server, fetch });

      expect(await gateway.call("listAgents", {})).toEqual({
        agents: [{ name: "Primary Test" }],
      });
      expect(ensures.length).toBe(2);
      expect(requests.map((r) => r.headers.authorization)).toEqual([
        "Bearer synthetic-gateway-1",
        "Bearer synthetic-gateway-2",
      ]);
    },
  );

  it("gives up after one retry", async () => {
    const { server } = fakeServer([sandbox(1), sandbox(2)]);
    const { fetch, requests } = fakeFetch([401, 401]);
    const gateway = createGatewayTransport({ server, fetch });

    await expect(gateway.call("listAgents", {})).rejects.toEqual(
      new GrokBotError(
        "auth",
        "listAgents was rejected with HTTP 401: expired. The Box Gateway refused fresh sandbox tokens.",
      ),
    );
    expect(requests.length).toBe(2);
  });

  it("does not retry other HTTP failures", async () => {
    const { server, ensures } = fakeServer([sandbox(1)]);
    const { fetch } = fakeFetch([500]);
    const gateway = createGatewayTransport({ server, fetch });
    await expect(gateway.call("listAgents", {})).rejects.toEqual(
      new GrokBotError("http", "listAgents failed with HTTP 500: expired"),
    );
    expect(ensures.length).toBe(1);
  });

  it("blocks a sensitive method before ensuring a sandbox", async () => {
    const { server, ensures } = fakeServer([sandbox(1)]);
    const { fetch, requests } = fakeFetch([]);
    const gateway = createGatewayTransport({ server, fetch });
    await expect(
      gateway.call("callMcpAppTool", { tool: "t" }),
    ).rejects.toMatchObject({ code: "safety" });
    expect([ensures.length, requests.length]).toEqual([0, 0]);
  });

  it("re-ensures when the gateway token expires between calls", async () => {
    const { server, ensures } = fakeServer([sandbox(1), sandbox(2)]);
    const { fetch, requests } = fakeFetch([200, 403, 200, 200]);
    const gateway = createGatewayTransport({ server, fetch });
    for (let i = 0; i < 3; i++) await gateway.call("listAgents", {});
    expect(ensures.length).toBe(2);
    expect(requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer synthetic-gateway-1",
      "Bearer synthetic-gateway-1",
      "Bearer synthetic-gateway-2",
      "Bearer synthetic-gateway-2",
    ]);
  });

  it("does not retry when EnsureSandBox itself is rejected", async () => {
    let ensures = 0;
    const stale = new GrokBotError("auth", "EnsureSandBox was rejected.");
    const server: ServerTransport = {
      async call() {
        ensures += 1;
        throw stale;
      },
      stream() {
        throw new Error("unused");
      },
    };
    const gateway = createGatewayTransport({
      server,
      fetch: fakeFetch([]).fetch,
    });
    await expect(gateway.call("listAgents", {})).rejects.toBe(stale);
    expect(ensures).toBe(1);
  });

  it("rejects an EnsureSandBox reply without gateway tokens", async () => {
    const { server } = fakeServer([{ gatewayUrl: GATEWAY_URL }, sandbox(2)]);
    const { fetch } = fakeFetch([]);
    const gateway = createGatewayTransport({ server, fetch });
    await expect(gateway.call("listAgents", {})).rejects.toEqual(
      new GrokBotError(
        "protocol",
        "EnsureSandBox did not return gatewayUrl, gatewayToken, and networkToken.",
      ),
    );
    expect(await gateway.call("listAgents", {})).toEqual({
      agents: [{ name: "Primary Test" }],
    });
  });

  it("keeps gateway tokens and URL out of error messages", async () => {
    const { server } = fakeServer([sandbox(1)]);
    const gateway = createGatewayTransport({
      server,
      fetch: async (url, init) => {
        const auth = new Headers(init.headers).get("authorization");
        return new Response(`${url} ${auth} synthetic-network-1`, {
          status: 500,
        });
      },
    });
    const error = await gateway
      .call("listAgents", {})
      .catch((caught: Error) => caught.message);
    expect(error).toBe(
      "listAgents failed with HTTP 500: [redacted]/api/listAgents Bearer [redacted] [redacted]",
    );
  });
});
