export type JsonObject = { readonly [key: string]: unknown };

export type GrokBotErrorCode =
  | "auth"
  | "http"
  | "protocol"
  | "safety"
  | "not-found"
  | "ambiguous"
  | "timeout";

export class GrokBotError extends Error {
  readonly code: GrokBotErrorCode;

  constructor(
    code: GrokBotErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GrokBotError";
    this.code = code;
  }
}

export interface CallOptions {
  /** Required to call a method tagged destructive, sensitive, or staff-only. */
  readonly confirmed?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** aiserver.v1.GrokBotService on api2.cursor.sh. */
export interface ServerTransport {
  call(
    method: string,
    body: JsonObject,
    options?: CallOptions,
  ): Promise<unknown>;
  /** Connect server-streaming call; yields each decoded JSON message frame. */
  stream(
    method: string,
    body: JsonObject,
    options?: CallOptions,
  ): AsyncIterable<unknown>;
}

/** Cloud Box Gateway at `<gatewayUrl>/api/<method>`, resolved via EnsureSandBox. */
export interface GatewayTransport {
  call(
    method: string,
    body: JsonObject,
    options?: CallOptions,
  ): Promise<unknown>;
}
