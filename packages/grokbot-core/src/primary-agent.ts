import type { ServerTransport } from "./contracts.js";
import { asJsonObject } from "./transcript.js";

/**
 * The agentId of the account's primary Bot (`settings.mainAgentId` of the user's runtime
 * settings), lowercase; undefined when the account has none.
 */
export async function readPrimaryAgentId(
  server: Pick<ServerTransport, "call">,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const raw = await server.call(
    "GetGrokBotUserRuntimeSettings",
    {},
    { signal },
  );
  const id = asJsonObject(asJsonObject(raw)?.settings)?.mainAgentId;
  const text = typeof id === "string" ? id.trim().toLowerCase() : "";
  return text === "" ? undefined : text;
}
