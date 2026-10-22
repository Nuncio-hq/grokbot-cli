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

/** What EnsureSandBox hands back, reduced to the headers each call sends. Lives in memory only. */
interface GatewaySession {
  readonly gatewayUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
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
        headers: sandbox.headers,
        options,
        secrets: sandbox.secrets,
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
      "EnsureSandBox did not return an https gatewayUrl with either gatewayToken and networkToken, or gatewayPortToken.",
    );
  }
  return sandbox;
}

function parseGatewaySession(reply: unknown): GatewaySession | undefined {
  if (!isRecord(reply)) return undefined;
  const { gatewayUrl, gatewayToken, networkToken, gatewayPortToken } = reply;
  if (typeof gatewayUrl !== "string" || !gatewayUrl.startsWith("https://")) {
    return undefined;
  }
  const token = optionalString(gatewayToken);
  const network = optionalString(networkToken);
  const port = optionalString(gatewayPortToken);
  if (token === undefined || network === undefined || port === undefined) {
    return undefined;
  }
  const url = gatewayUrl.replace(/\/+$/, "");
  const secrets = [token, network, port, url];
  // The app (`kre()`) falls back to the port token only when there is no network token.
  if (network !== "") {
    if (token === "") return undefined;
    return {
      gatewayUrl: url,
      headers: {
        authorization: `Bearer ${token}`,
        "x-anyrun-network-token": network,
      },
      secrets,
    };
  }
  if (port === "") return undefined;
  return {
    gatewayUrl: url,
    headers: {
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
      "x-anyrun-port-token": port,
    },
    secrets,
  };
}

/** A missing field counts as empty; a non-string value is malformed. */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
