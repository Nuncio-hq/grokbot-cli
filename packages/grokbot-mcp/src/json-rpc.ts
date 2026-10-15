import type { JsonObject } from "grokbot-core";

export type RequestId = string | number;

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: object;
}

export type Outcome =
  | { readonly result: object }
  | { readonly error: RpcError };

export type Incoming =
  | {
      readonly kind: "request";
      readonly id: RequestId;
      readonly method: string;
      readonly params: JsonObject;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: JsonObject;
    }
  | {
      readonly kind: "invalid";
      readonly id: RequestId | null;
      readonly error: RpcError;
    };

export const PARSE_ERROR: RpcError = { code: -32700, message: "Parse error" };
export const INVALID_REQUEST: RpcError = {
  code: -32600,
  message: "Invalid Request",
};
export const INTERNAL_ERROR: RpcError = {
  code: -32603,
  message: "Internal error",
};

export const methodNotFound = (method: string): RpcError => ({
  code: -32601,
  message: `Method not found: ${method}`,
});

export const invalidParams = (detail: string): RpcError => ({
  code: -32602,
  message: `Invalid params: ${detail}`,
});

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || Number.isInteger(value);
}

/** Parses one stdio line. MCP forbids batches and null ids, so both are invalid. */
export function parseIncoming(line: string): Incoming {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { kind: "invalid", id: null, error: PARSE_ERROR };
  }
  if (!isJsonObject(message)) {
    return { kind: "invalid", id: null, error: INVALID_REQUEST };
  }
  const { id, method, params = {} } = message;
  const hasId = Object.hasOwn(message, "id");
  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return {
      kind: "invalid",
      id: isRequestId(id) ? id : null,
      error: INVALID_REQUEST,
    };
  }
  if (!hasId) {
    return {
      kind: "notification",
      method,
      params: isJsonObject(params) ? params : {},
    };
  }
  if (!isRequestId(id)) {
    return { kind: "invalid", id: null, error: INVALID_REQUEST };
  }
  if (!isJsonObject(params)) {
    return {
      kind: "invalid",
      id,
      error: invalidParams("params must be an object"),
    };
  }
  return { kind: "request", id, method, params };
}

export function encodeResponse(id: RequestId | null, outcome: Outcome): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, ...outcome })}\n`;
}
