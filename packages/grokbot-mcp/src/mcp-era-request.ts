import type { JsonObject } from "grokbot-core";
import { invalidParams, isJsonObject, type RpcError } from "./json-rpc.js";

/** Revisions that open with the initialize handshake, newest first. */
export const LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** Stateless revisions: every request carries its version and client capabilities in `_meta`. */
export const MODERN_VERSIONS = ["2026-07-28"] as const;

/** Advertised by server/discover and by -32022: every version this server answers, modern first. */
export const SUPPORTED_VERSIONS: readonly string[] = [
  ...MODERN_VERSIONS,
  ...LEGACY_VERSIONS,
];

export type Era = "legacy" | "modern";

const PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const unsupportedVersion = (requested: string): RpcError => ({
  code: -32022,
  message: "Unsupported protocol version",
  data: { supported: SUPPORTED_VERSIONS, requested },
});

/**
 * Reads a request's era from its own `_meta`, never from earlier requests.
 * The version is checked before the other fields because a newer revision may define them differently.
 */
export function requestEra(
  params: JsonObject,
): { readonly era: Era } | { readonly error: RpcError } {
  const meta = params._meta;
  if (!isJsonObject(meta) || !Object.hasOwn(meta, PROTOCOL_VERSION)) {
    return { era: "legacy" };
  }
  const version = meta[PROTOCOL_VERSION];
  if (typeof version !== "string") {
    return {
      error: invalidParams(`_meta ${PROTOCOL_VERSION} must be a string`),
    };
  }
  if (!MODERN_VERSIONS.some((modern) => modern === version)) {
    return { error: unsupportedVersion(version) };
  }
  if (!Object.hasOwn(meta, CLIENT_CAPABILITIES)) {
    return { error: invalidParams(`_meta ${CLIENT_CAPABILITIES} is required`) };
  }
  if (!isJsonObject(meta[CLIENT_CAPABILITIES])) {
    return {
      error: invalidParams(`_meta ${CLIENT_CAPABILITIES} must be an object`),
    };
  }
  return { era: "modern" };
}
