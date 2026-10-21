import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the Grok Bot desktop app installs on macOS. */
export const INSTALLED_APP_PATH = "/Applications/Grok Bot.app";

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Whether a string is a plain semantic version (`1.2.3`, optionally `-pre` and `+build`). */
export const isVersion = (value: string): boolean => SEMVER.test(value);

/** Compares two digit strings of any length without losing precision. */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Semver rules for one prerelease identifier: numbers sort below words. */
function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return compareDigits(a, b);
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two semantic versions: -1, 0 or 1. Build metadata is ignored and a prerelease
 * sorts below its release. `undefined` when either side is not a semantic version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) return undefined;
  for (const part of [1, 2, 3] as const) {
    const diff = compareDigits(left[part] ?? "0", right[part] ?? "0");
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const leftPre = left[4]?.split(".");
  const rightPre = right[4]?.split(".");
  if (!leftPre || !rightPre) {
    return leftPre ? -1 : rightPre ? 1 : 0;
  }
  for (let i = 0; i < Math.min(leftPre.length, rightPre.length); i++) {
    const diff = compareIdentifier(leftPre[i] ?? "", rightPre[i] ?? "");
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const diff = leftPre.length - rightPre.length;
  return diff === 0 ? 0 : diff < 0 ? -1 : 1;
}

/** True only when `candidate` is a semantic version strictly above `base`. */
export const isNewerVersion = (candidate: string, base: string): boolean =>
  compareVersions(candidate, base) === 1;

const BUNDLE_VERSION =
  /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/;

/** The `CFBundleShortVersionString` of an XML `Info.plist`, or undefined when there is none. */
export function parseBundleVersion(plist: string): string | undefined {
  return BUNDLE_VERSION.exec(plist)?.[1]?.trim() || undefined;
}

type ReadText = (path: string) => Promise<string>;

/** The version of the `.app` bundle at `appPath`; undefined when it is absent or unreadable. */
export async function readBundleVersion(
  appPath: string,
  read: ReadText = (path) => readFile(path, "utf8"),
): Promise<string | undefined> {
  try {
    return parseBundleVersion(
      await read(join(appPath, "Contents", "Info.plist")),
    );
  } catch {
    return undefined;
  }
}

interface InstalledAppOptions {
  /** Default: process.platform. Only macOS has the app. */
  readonly platform?: string;
  /** Default: /Applications/Grok Bot.app. */
  readonly appPath?: string;
  readonly read?: ReadText;
}

/**
 * The version of the installed Grok Bot desktop app. Undefined, never an error, when
 * this is not macOS or the app is absent or its `Info.plist` has no readable version.
 */
export async function readInstalledAppVersion(
  options: InstalledAppOptions = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "darwin") return undefined;
  return readBundleVersion(options.appPath ?? INSTALLED_APP_PATH, options.read);
}

/** The `app_version` of the tools-and-API catalog; throws when the catalog has none. */
export function parseCatalogAppVersion(catalog: unknown): string {
  const version =
    typeof catalog === "object" && catalog !== null && "app_version" in catalog
      ? catalog.app_version
      : undefined;
  if (typeof version !== "string" || !isVersion(version)) {
    throw new Error("The catalog has no valid app_version.");
  }
  return version;
}
