import { isVersion } from "../src/app-version.js";
import { member } from "./app-schema.js";

/** The update feed the desktop app polls (`buildUpdateRequestUrl` in its main bundle). */
const FEED_BASE = "https://api2.cursor.sh/updates/api/update";
const FEED_PLATFORM = "darwin-arm64";
const FEED_CHANNEL = "sand";
const FEED_TIMEOUT_MS = 30_000;

/** The feed wants a machine id; this fixed one is not any real machine's. */
export const PLACEHOLDER_MACHINE_ID = "00000000-0000-0000-0000-000000000000";

export const updateFeedUrl = (fromVersion: string): string =>
  `${FEED_BASE}/${FEED_PLATFORM}/${FEED_CHANNEL}/${encodeURIComponent(fromVersion)}/${PLACEHOLDER_MACHINE_ID}/stable`;

/** Where the release zip of one version lives. */
export const releaseZipUrl = (version: string): string =>
  `https://downloads.cursor.com/grokbot/stable/${FEED_PLATFORM}/${version}/Grok_Bot_${version}.zip`;

export interface LatestBuild {
  readonly version: string;
  readonly url: string;
}

/**
 * Reads a feed answer. 204 means nothing is newer than the version asked from
 * (undefined); 200 carries `{url, name}` where `name` is the version and the URL is an
 * https download of that same version. Anything else throws.
 */
export function parseUpdateResponse(
  status: number,
  body: string,
): LatestBuild | undefined {
  if (status === 204) return undefined;
  if (status !== 200) {
    throw new Error(`The update feed answered HTTP ${status}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("The update feed's answer is not JSON.");
  }
  const name = member(json, "name");
  const rawUrl = member(json, "url");
  if (typeof name !== "string" || !isVersion(name)) {
    throw new Error("The update feed's answer has no valid version name.");
  }
  if (typeof rawUrl !== "string") {
    throw new Error("The update feed's answer has no download url.");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The update feed's download url is not a URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("The update feed's download url is not https.");
  }
  const [folder, file] = url.pathname.split("/").slice(-2);
  if (folder !== name || file !== `Grok_Bot_${name}.zip`) {
    throw new Error(
      `The update feed names version ${name} but its download url is ${url.pathname}.`,
    );
  }
  return { version: name, url: url.href };
}

/** The newest build the feed offers to an app at `fromVersion`; undefined when none is newer. */
export async function fetchLatestBuild(
  fromVersion: string,
  fetchFeed: typeof fetch = fetch,
): Promise<LatestBuild | undefined> {
  const response = await fetchFeed(updateFeedUrl(fromVersion), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  return parseUpdateResponse(response.status, await response.text());
}
