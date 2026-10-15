import {
  createConnectFrameDecoder,
  encodeConnectEnvelope,
} from "./connect-frames.js";
import {
  type CallOptions,
  GrokBotError,
  type JsonObject,
  type ServerTransport,
} from "./contracts.js";
import { assertMethodAllowed } from "./method-safety.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ServerTransportOptions {
  /** Called before every request. The transport never keeps the token. */
  readonly getToken: () => Promise<string>;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly userAgent?: string;
}

/** One POST to either backend. Shared with the gateway transport. */
export interface HttpRequest {
  readonly fetch: FetchLike;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly options: CallOptions;
  /** Values scrubbed from every error message this request produces. */
  readonly secrets: readonly string[];
  /** Appended to the auth error on HTTP 401 or 403. */
  readonly authHint: string;
}

const STALE_LOGIN_HINT =
  "If the login is stale, run grokbot login or open the Grok Bot app once to refresh it.";
const MAX_ERROR_BODY_CHARS = 300;

export function createServerTransport({
  getToken,
  fetch = (url, init) => globalThis.fetch(url, init),
  baseUrl = "https://api2.cursor.sh",
  userAgent = "grokbot-core",
}: ServerTransportOptions): ServerTransport {
  const root = `${baseUrl.replace(/\/+$/, "")}/aiserver.v1.GrokBotService`;
  const prepare = async (
    method: string,
    options: CallOptions,
  ): Promise<HttpRequest> => {
    const token = await getToken();
    return {
      fetch,
      method,
      url: `${root}/${method}`,
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://cursor.com",
        "user-agent": userAgent,
      },
      options,
      secrets: [token],
      authHint: STALE_LOGIN_HINT,
    };
  };

  return {
    async call(method, body, options = {}) {
      assertMethodAllowed(method, options.confirmed === true);
      return postJson(await prepare(method, options), body);
    },
    stream(method, body, options = {}) {
      assertMethodAllowed(method, options.confirmed === true);
      return streamMessages(() => prepare(method, options), body);
    },
  };
}

export async function postJson(
  request: HttpRequest,
  body: JsonObject,
): Promise<unknown> {
  const { method } = request;
  const deadline = createDeadline(request);
  try {
    const response = await request.fetch(request.url, {
      method: "POST",
      headers: { ...request.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
    if (!response.ok) throw await responseFailure(request, response);
    const text = await response.text();
    if (text === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new GrokBotError("protocol", `${method} returned a non-JSON body.`);
    }
  } catch (error) {
    throw deadline.toError(error);
  }
}

async function* streamMessages(
  prepare: () => Promise<HttpRequest>,
  body: JsonObject,
): AsyncGenerator<unknown, void, undefined> {
  const request = await prepare();
  const { method, options } = request;
  const deadline = createDeadline(request);
  try {
    const response = await request.fetch(request.url, {
      method: "POST",
      headers: {
        ...request.headers,
        "content-type": "application/connect+json",
        "connect-protocol-version": "1",
      },
      body: encodeConnectEnvelope(body),
      signal: deadline.signal,
    });
    if (!response.ok) throw await responseFailure(request, response);
    if (response.body === null) {
      throw new GrokBotError("protocol", `${method} returned no stream body.`);
    }
    const decoder = createConnectFrameDecoder();
    for await (const chunk of response.body) {
      for (const frame of decoder.push(chunk)) {
        if (options.signal?.aborted) return;
        if (frame.kind === "message") {
          yield frame.json;
          continue;
        }
        if (frame.error === undefined) return;
        const { code, message } = frame.error;
        const detail = message === undefined ? code : `${code}: ${message}`;
        throw new GrokBotError(
          "protocol",
          redact(`${method} stream ended with ${detail}`, request.secrets),
        );
      }
    }
    decoder.finish();
    throw new GrokBotError(
      "protocol",
      `${method} stream closed without an end-of-stream frame.`,
    );
  } catch (error) {
    if (options.signal?.aborted) return;
    throw deadline.toError(error);
  }
}

function createDeadline({ method, options }: HttpRequest) {
  const { timeoutMs, signal: callerSignal } = options;
  const timer =
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const sources = [callerSignal, timer].filter((s) => s !== undefined);
  return {
    signal: sources.length > 0 ? AbortSignal.any(sources) : undefined,
    toError(error: unknown): unknown {
      if (error instanceof GrokBotError) return error;
      if (callerSignal?.aborted) return callerSignal.reason;
      if (timer?.aborted) {
        return new GrokBotError(
          "timeout",
          `${method} timed out after ${timeoutMs} ms.`,
        );
      }
      return new GrokBotError(
        "http",
        `${method} request failed on the network.`,
      );
    },
  };
}

async function responseFailure(
  request: HttpRequest,
  response: Response,
): Promise<GrokBotError> {
  const raw = await response.text().catch(() => "");
  const text = redact(raw, request.secrets).slice(0, MAX_ERROR_BODY_CHARS);
  const status = `HTTP ${response.status}`;
  const detail = text === "" ? status : `${status}: ${text}`;
  return response.status === 401 || response.status === 403
    ? new GrokBotError(
        "auth",
        `${request.method} was rejected with ${detail}. ${request.authHint}`,
      )
    : new GrokBotError("http", `${request.method} failed with ${detail}`);
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
}
