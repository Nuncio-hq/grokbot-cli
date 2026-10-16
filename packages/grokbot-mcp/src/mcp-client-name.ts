import { isJsonObject } from "./json-rpc.js";

/**
 * The name the MCP client gave for itself: `clientInfo.name` from initialize, or the
 * stateless era's `_meta` clientInfo. Kept in memory only, so the usage log can map it to
 * a fixed label (usage-client.ts); the name itself is never written anywhere.
 */
let name: string | undefined;

const CLIENT_INFO = "io.modelcontextprotocol/clientInfo";

export function mcpClientName(): string | undefined {
  return name;
}

/** Notes the client's name from initialize params or a request's `_meta`. */
export function noteMcpClient(params: Readonly<Record<string, unknown>>): void {
  const meta = params._meta;
  const info =
    params.clientInfo ?? (isJsonObject(meta) ? meta[CLIENT_INFO] : undefined);
  const value = isJsonObject(info) ? info.name : undefined;
  if (typeof value === "string" && value.trim() !== "") name = value.trim();
}
