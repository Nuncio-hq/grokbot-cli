import { isIP } from "node:net";
import { GrokBotError } from "./contracts.js";

/**
 * A proxy that is misconfigured or refuses the call. Its message names the proxy's
 * host:port at most, never the proxy URL, so it is safe to show wherever an error goes.
 */
export class ProxyError extends GrokBotError {
  constructor(message: string) {
    super("http", message);
    this.name = "ProxyError";
  }
}

/** The process environment, or a stand-in. */
export type ProxyEnv = Readonly<Record<string, string | undefined>>;

/**
 * The proxy a call goes through. Opt-in: nothing is proxied unless the environment
 * names one. Holds the credentials (as a ready `Proxy-Authorization` value), so it is
 * never printed: show `describeProxy(...)` instead.
 */
export interface ProxyConfig {
  readonly scheme: "http" | "https";
  /** Host name or IP without brackets. */
  readonly host: string;
  readonly port: number;
  /** `Basic ...` when the proxy URL carries credentials. */
  readonly authorization?: string;
  /** The environment variable the proxy URL came from. */
  readonly source: string;
}

/** Highest first: the grokbot override, then the standard names. */
const PROXY_VARIABLES = ["GROKBOT_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"];
const NO_PROXY_VARIABLES = ["GROKBOT_NO_PROXY", "NO_PROXY", "no_proxy"];
const DEFAULT_PORTS = { http: 80, https: 443 } as const;

/**
 * The proxy for a call to `target`, or null for a direct connection.
 * `GROKBOT_HTTPS_PROXY` wins over `HTTPS_PROXY` over `https_proxy`; an empty variable
 * counts as unset, and `GROKBOT_HTTPS_PROXY=off` forces direct. Only https targets are
 * proxied. Loopback and anything `GROKBOT_NO_PROXY`/`NO_PROXY`/`no_proxy` (the first
 * non-empty one) names are always direct. Throws a GrokBotError for a proxy URL that is
 * malformed or not http(s); the error never carries the value.
 */
export function resolveProxy(
  target: string | URL,
  env: ProxyEnv = process.env,
): ProxyConfig | null {
  const setting = proxySetting(env);
  if (setting === undefined) return null;
  const url = typeof target === "string" ? parseUrl(target) : target;
  if (url === undefined || url.protocol !== "https:") return null;
  if (bypassesProxy(url, env)) return null;
  return parseProxy(setting.name, setting.value);
}

/** What to show a human or put in JSON: no credentials. */
export function describeProxy(proxy: ProxyConfig): {
  readonly url: string;
  readonly source: string;
} {
  return {
    url: `${proxy.scheme}://${hostWithPort(proxy.host, proxy.port)}`,
    source: proxy.source,
  };
}

/** `host:port`, bracketing an IPv6 host. */
export function hostWithPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function proxySetting(
  env: ProxyEnv,
): { readonly name: string; readonly value: string } | undefined {
  for (const name of PROXY_VARIABLES) {
    const value = env[name]?.trim();
    if (value === undefined || value === "") continue;
    // The override can only switch the standard variables off, never the reverse.
    if (name === "GROKBOT_HTTPS_PROXY" && value.toLowerCase() === "off") {
      return undefined;
    }
    return { name, value };
  }
  return undefined;
}

function parseProxy(source: string, value: string): ProxyConfig {
  const bad = () =>
    new ProxyError(
      `${source} must be an http:// or https:// proxy URL such as http://host:port (credentials may be included as http://user:pass@host:port). The value is not shown because it may hold credentials. Fix it, or set GROKBOT_HTTPS_PROXY=off to connect directly.`,
    );
  const url = parseUrl(value);
  if (url === undefined) throw bad();
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad();
  const scheme = url.protocol === "https:" ? "https" : "http";
  const host = stripBrackets(url.hostname);
  if (host === "") throw bad();
  let authorization: string | undefined;
  if (url.username !== "" || url.password !== "") {
    try {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    } catch {
      throw bad();
    }
  }
  return {
    scheme,
    host,
    port: url.port === "" ? DEFAULT_PORTS[scheme] : Number(url.port),
    ...(authorization === undefined ? {} : { authorization }),
    source,
  };
}

function parseUrl(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function bypassesProxy(url: URL, env: ProxyEnv): boolean {
  // As the NO_PROXY rules compare it: lowercase, no brackets, no trailing dot.
  const host = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (isLoopback(host)) return true;
  const port = url.port === "" ? DEFAULT_PORTS.https : Number(url.port);
  const list = NO_PROXY_VARIABLES.map((name) => env[name]?.trim()).find(
    (value) => value !== undefined && value !== "",
  );
  if (list === undefined) return false;
  return list
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .some((entry) => matchesEntry(entry.toLowerCase(), host, port));
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  // `new URL` writes an IPv4-mapped address in hex: [::ffff:127.0.0.1] is ::ffff:7f00:1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1];
  if (mapped !== undefined) return Number.parseInt(mapped, 16) >> 8 === 127;
  return host === "::1";
}

/**
 * One NO_PROXY entry. `*` matches all. `host` matches that host and its subdomains;
 * `.suffix` and `*.suffix` match subdomains only. `:port` limits it to one port.
 */
function matchesEntry(entry: string, host: string, port: number): boolean {
  if (entry === "*") return true;
  const { name, entryPort } = splitEntry(entry);
  if (entryPort !== undefined && entryPort !== port) return false;
  if (name === "") return false;
  if (name === "*") return true;
  if (name.startsWith("*.")) return host.endsWith(name.slice(1));
  if (name.startsWith(".")) return host.endsWith(name);
  const bare = name.replace(/\.$/, "");
  return host === bare || (isIP(host) === 0 && host.endsWith(`.${bare}`));
}

function splitEntry(entry: string): {
  readonly name: string;
  readonly entryPort: number | undefined;
} {
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    return {
      name: bracketed[1] ?? "",
      entryPort: bracketed[2] === undefined ? undefined : Number(bracketed[2]),
    };
  }
  // Several colons without brackets: a bare IPv6 address, no port.
  if (entry.split(":").length > 2) return { name: entry, entryPort: undefined };
  const colon = entry.lastIndexOf(":");
  if (colon === -1) return { name: entry, entryPort: undefined };
  const tail = entry.slice(colon + 1);
  return /^\d+$/.test(tail)
    ? { name: entry.slice(0, colon), entryPort: Number(tail) }
    : { name: entry, entryPort: undefined };
}
