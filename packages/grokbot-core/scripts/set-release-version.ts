import { readFile, writeFile } from "node:fs/promises";

/**
 * Sets the release version field by field, never with a global replace (0.1.4 once
 * bumped an outside dependency that way): each package's `version`, the cli and mcp
 * `grokbot-core` range (in their package.json and in bun.lock, where bun 1.4 leaves the
 * workspace ranges stale), and GROKBOT_VERSION. Prints `version=x.y.z` for $GITHUB_OUTPUT.
 * Usage: bun packages/grokbot-core/scripts/set-release-version.ts <patch|minor|major|none>
 * `none` keeps the current version (to retry a release whose publish failed).
 */

const BUMPS = ["patch", "minor", "major", "none"] as const;
type Bump = (typeof BUMPS)[number];

const PACKAGES = ["grokbot-core", "grokbot-cli", "grokbot-mcp"];
const packageUrl = (dir: string) =>
  new URL(`../../${dir}/package.json`, import.meta.url);
const versionUrl = new URL("../src/version.ts", import.meta.url);
const lockUrl = new URL("../../../bun.lock", import.meta.url);
const VERSION_LINE = /^export const GROKBOT_VERSION = "[^"]*";$/m;
/** A workspace's `grokbot-core` dependency range in bun.lock; the packages section uses another shape. */
const LOCK_CORE_RANGE = /^(\s+"grokbot-core": )"\^\d+\.\d+\.\d+"(,?)$/gm;

function nextVersion(current: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`${current} is not a plain x.y.z version.`);
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return current;
  }
}

const bump = process.argv[2] as Bump;
if (!BUMPS.includes(bump)) {
  console.error(`Usage: set-release-version.ts <${BUMPS.join("|")}>`);
  process.exit(2);
}

const core = JSON.parse(await readFile(packageUrl("grokbot-core"), "utf8"));
const version = nextVersion(core.version, bump);

for (const dir of PACKAGES) {
  const pkg = JSON.parse(await readFile(packageUrl(dir), "utf8"));
  pkg.version = version;
  if (pkg.dependencies?.["grokbot-core"] !== undefined) {
    pkg.dependencies["grokbot-core"] = `^${version}`;
  }
  await writeFile(packageUrl(dir), `${JSON.stringify(pkg, null, 2)}\n`);
}

const source = await readFile(versionUrl, "utf8");
if (!VERSION_LINE.test(source)) {
  throw new Error(
    "GROKBOT_VERSION line not found in grokbot-core/src/version.ts.",
  );
}
await writeFile(
  versionUrl,
  source.replace(VERSION_LINE, `export const GROKBOT_VERSION = "${version}";`),
);

const lock = await readFile(lockUrl, "utf8");
await writeFile(
  lockUrl,
  lock.replace(
    LOCK_CORE_RANGE,
    (_line, key, comma) => `${key}"^${version}"${comma}`,
  ),
);

console.log(`version=${version}`);
