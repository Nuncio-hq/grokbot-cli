import { GrokBotError } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/**
 * Builds the browser URL for one bot's desktop from an EnsureSandBoxWindow response.
 * A browser cannot send the `x-anyrun-network-token` header, so the token rides as the
 * `network_token` query param on the page and inside its websockify `path`, the shape the
 * app's own viewer builds (REA: `cx()` in the gateway client, app v0.70.2).
 *
 * The result is a credential: callers open it or print it with a warning, never log it.
 */
export function vncViewerUrl(response: unknown): string {
  const o = asJsonObject(response) ?? {};
  const vncUrl = readString(o, "vncUrl") ?? "";
  const networkToken = readString(o, "networkToken") ?? "";
  if (vncUrl === "" || networkToken === "") {
    throw new GrokBotError(
      "protocol",
      "EnsureSandBoxWindow did not return a viewer URL and network token.",
    );
  }
  let url: URL;
  try {
    url = new URL(vncUrl);
  } catch {
    throw new GrokBotError(
      "protocol",
      "EnsureSandBoxWindow returned a viewer URL that does not parse.",
    );
  }
  if (!url.searchParams.has("network_token")) {
    url.searchParams.set("network_token", networkToken);
  }
  const path = url.searchParams.get("path") ?? "websockify";
  if (!path.includes("network_token=")) {
    const join = path.includes("?") ? "&" : "?";
    url.searchParams.set("path", `${path}${join}network_token=${networkToken}`);
  }
  return url.toString();
}
