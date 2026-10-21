import {
  type CallOptions,
  type GatewayTransport,
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { assertGatewayMethodAllowed } from "./method-safety.js";
import { proxyFetch } from "./network-fetch.js";
import { type FetchLike, postJson } from "./server-transport.js";

interface GatewayTransportOptions {
  readonly server: ServerTransport;
  readonly fetch?: FetchLike;
}

/** What EnsureSandBox hands back. Lives in memory only. */
interface GatewaySession {
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly networkToken: string;
}

export function createGatewayTransport({
  server,
  fetch = proxyFetch,
}: GatewayTransportOptions): GatewayTransport {
  let session: Promise<GatewaySession> | undefined;
  const ensure = (): Promise<GatewaySession> => {
    session ??= ensureSandbox(server).catch((error: unknown) => {
      session = undefined;
      throw error;
    });
    return session;
  };

  const post = (
    sandbox: GatewaySession,
    method: string,
    body: JsonObject,
    options: CallOptions,
  ) =>
    postJson(
      {
        fetch,
        method,
        url: `${sandbox.gatewayUrl}/api/${method}`,
        headers: {
          authorization: `Bearer ${sandbox.gatewayToken}`,
          "x-anyrun-network-token": sandbox.networkToken,
        },
        options,
        secrets: [
          sandbox.gatewayToken,
          sandbox.networkToken,
          sandbox.gatewayUrl,
        ],
        authHint: "The Box Gateway refused fresh sandbox tokens.",
      },
      body,
    );

  return {
    async call(method, body, options = {}) {
      assertGatewayMethodAllowed(method, options.confirmed === true);
      const used = ensure();
      const sandbox = await used;
      try {
        return await post(sandbox, method, body, options);
      } catch (error) {
        if (!(error instanceof GrokBotError && error.code === "auth")) {
          throw error;
        }
        if (session === used) session = undefined;
        return post(await ensure(), method, body, options);
      }
    },
  };
}

async function ensureSandbox(server: ServerTransport): Promise<GatewaySession> {
  const reply = await server.call("EnsureSandBox", {});
  const sandbox = parseGatewaySession(reply);
  if (sandbox === undefined) {
    throw new GrokBotError(
      "protocol",
      "EnsureSandBox did not return gatewayUrl, gatewayToken, and networkToken.",
    );
  }
  return sandbox;
}

function parseGatewaySession(reply: unknown): GatewaySession | undefined {
  if (!isRecord(reply)) return undefined;
  const { gatewayUrl, gatewayToken, networkToken } = reply;
  if (
    typeof gatewayUrl !== "string" ||
    typeof gatewayToken !== "string" ||
    typeof networkToken !== "string" ||
    !gatewayUrl.startsWith("https://") ||
    gatewayToken === "" ||
    networkToken === ""
  ) {
    return undefined;
  }
  return {
    gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
    gatewayToken,
    networkToken,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
