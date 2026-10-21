import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  compareVersions,
  INSTALLED_APP_PATH,
  isVersion,
  parseCatalogAppVersion,
  readBundleVersion,
} from "../src/app-version.js";
import {
  catalogGaps,
  diffSchemas,
  type MapDiff,
  member,
  readAppSchema,
} from "./app-schema.js";
import {
  type DiffReport,
  renderSummary,
  type Signature,
} from "./app-summary.js";
import { fetchLatestBuild, releaseZipUrl } from "./app-update-feed.js";

/**
 * Maintainer check: is the installed Grok Bot desktop app newer than the catalog
 * (docs/grokbot-tools-and-api.json), and with --diff, what did it change?
 *
 *   bun run check:app [--app <path to .app>] [--previous <version>] [--diff] [--json]
 *   bun run check:app --diff --current <latest | version> [--previous <version>]
 *                     [--summary <file>] [--json]
 *
 * Without --diff it only reads the installed app's version and compares it with the
 * catalog's `app_version`; nothing touches the network. With --diff it downloads the
 * previous release (the catalog's version unless --previous), checks both bundles'
 * code signature and Team ID, extracts both app.asar files, and diffs services,
 * methods, message fields, the bot tool registry, the Box Gateway method table and the
 * client gates, then lists where the catalog no longer matches the new app.
 *
 * --current replaces the installed app as the new side: `latest` asks the update feed
 * for the newest build after the previous version (a placeholder machine id is sent,
 * never a real one) and ends with "nothing newer" when the feed has none; a version
 * downloads that release. --summary writes a short Markdown summary of the comparison
 * (for an issue body) and writes nothing when there is no comparison.
 * Scripts are not published: this file is not part of any package.
 */

const catalogUrl = new URL(
  "../../../docs/grokbot-tools-and-api.json",
  import.meta.url,
);
const exec = promisify(execFile);
const LINE_WIDTH = 96;

const USAGE =
  "Usage: bun run check:app [--app <path to .app>] [--previous <version>] [--diff] [--json]\n       bun run check:app --diff --current <latest | version> [--previous <version>] [--summary <file>] [--json]";

interface Options {
  readonly app: string | undefined;
  readonly previous: string | undefined;
  /** `latest`, a version, or undefined for the installed app. */
  readonly current: string | undefined;
  readonly summary: string | undefined;
  readonly diff: boolean;
  readonly json: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      app: { type: "string" },
      previous: { type: "string" },
      current: { type: "string" },
      summary: { type: "string" },
      diff: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.previous !== undefined && !isVersion(values.previous)) {
    throw new UsageError(`--previous ${values.previous} is not a version.`);
  }
  if (
    values.current !== undefined &&
    values.current !== "latest" &&
    !isVersion(values.current)
  ) {
    throw new UsageError(
      `--current ${values.current} is neither "latest" nor a version.`,
    );
  }
  if (values.current !== undefined && values.app !== undefined) {
    throw new UsageError("--current and --app cannot be combined.");
  }
  if (
    (values.current !== undefined || values.summary !== undefined) &&
    !values.diff
  ) {
    throw new UsageError("--current and --summary need --diff.");
  }
  return {
    app: values.app,
    previous: values.previous,
    current: values.current,
    summary: values.summary,
    diff: values.diff,
    json: values.json,
  };
}

class UsageError extends Error {}

type Relation = "not-installed" | "same" | "newer" | "older" | "unknown";

/** How the installed app compares with the catalog. */
function relate(installed: string | undefined, catalog: string): Relation {
  if (installed === undefined) return "not-installed";
  switch (compareVersions(installed, catalog)) {
    case 0:
      return "same";
    case 1:
      return "newer";
    case -1:
      return "older";
    case undefined:
      return "unknown";
  }
}

const RELATION_TEXT: Record<Relation, string> = {
  "not-installed": "The Grok Bot app is not installed (or not at this path).",
  same: "The catalog matches the installed app.",
  newer: "The installed app is newer than the catalog: run with --diff.",
  older: "The installed app is older than the catalog.",
  unknown: "The installed app's version is not a plain version.",
};

/** `codesign --verify --deep --strict` and the bundle's TeamIdentifier. */
async function checkSignature(appPath: string): Promise<Signature> {
  try {
    await exec("codesign", ["--verify", "--deep", "--strict", appPath]);
  } catch (error) {
    const stderr = member(error, "stderr");
    return {
      verified: false,
      teamIdentifier: undefined,
      problem: (typeof stderr === "string" && stderr
        ? stderr
        : String(error)
      ).trim(),
    };
  }
  // codesign -d writes its description to stderr.
  const { stderr } = await exec("codesign", ["-d", "--verbose=2", appPath]);
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]?.trim();
  return {
    verified: true,
    teamIdentifier: team && team !== "not set" ? team : undefined,
  };
}

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${url} failed: HTTP ${response.status}.`);
  }
  const size = Number(response.headers.get("content-length"));
  say(
    `Downloading ${url}${size > 0 ? ` (${Math.round(size / 1e6)} MB)` : ""}...`,
  );
  await Bun.write(to, response);
}

/** The one `*.app` bundle directly inside `dir`. */
async function findApp(dir: string): Promise<string> {
  const apps = (await readdir(dir)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1 || apps[0] === undefined) {
    throw new Error(`Expected one .app in the download, found ${apps.length}.`);
  }
  return join(dir, apps[0]);
}

/** Extracts `Contents/Resources/app.asar` of a bundle and reads its schema. */
async function extractSchema(appPath: string, workDir: string) {
  say(`Extracting ${join(appPath, "Contents/Resources/app.asar")}...`);
  await exec(
    "bunx",
    [
      "@electron/asar",
      "extract",
      join(appPath, "Contents", "Resources", "app.asar"),
      workDir,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return readAppSchema(workDir);
}

/** The new side of a comparison: the installed bundle, or a release zip to download. */
type CurrentApp =
  | { readonly version: string; readonly path: string }
  | { readonly version: string; readonly url: string };

/** Downloads a release zip into `work` and unzips it; the path of its `.app`. */
async function fetchApp(
  url: string,
  version: string,
  work: string,
  name: string,
): Promise<string> {
  const zip = join(work, `Grok_Bot_${version}.zip`);
  await download(url, zip);
  const unzipped = join(work, name);
  // ditto keeps the bundle's symlinks and attributes, so its signature still verifies.
  await exec("ditto", ["-x", "-k", zip, unzipped]);
  return findApp(unzipped);
}

async function compareApps(
  previous: string,
  current: CurrentApp,
  catalog: unknown,
): Promise<DiffReport> {
  const work = await mkdtemp(join(tmpdir(), "grokbot-app-check-"));
  try {
    const previousPath = await fetchApp(
      releaseZipUrl(previous),
      previous,
      work,
      "previous-app",
    );
    const currentPath =
      "path" in current
        ? current.path
        : await fetchApp(current.url, current.version, work, "current-app");

    const signature = {
      previous: await checkSignature(previousPath),
      current: await checkSignature(currentPath),
    };
    const { previous: before, current: after } = signature;
    if (!before.verified || !after.verified) {
      throw new Error(
        `Code signature check failed: ${before.problem ?? after.problem}`,
      );
    }
    if (
      before.teamIdentifier === undefined ||
      before.teamIdentifier !== after.teamIdentifier
    ) {
      throw new Error(
        `The bundles are not from the same team (${before.teamIdentifier ?? "none"} vs ${after.teamIdentifier ?? "none"}).`,
      );
    }

    const oldSchema = await extractSchema(previousPath, join(work, "old"));
    const newSchema = await extractSchema(currentPath, join(work, "new"));
    return {
      previous,
      current: current.version,
      signature,
      schema: diffSchemas(oldSchema, newSchema),
      gaps: catalogGaps(catalog, newSchema),
      unresolved: {
        previous: oldSchema.unresolved,
        current: newSchema.unresolved,
      },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Names joined by ", " and wrapped under a two-space indent. */
function wrapped(names: readonly string[], indent = "    "): string {
  const lines: string[] = [];
  let line = indent;
  for (const name of names) {
    const next = line === indent ? name : `, ${name}`;
    if (line !== indent && line.length + next.length > LINE_WIDTH) {
      lines.push(`${line},`);
      line = `${indent}${name}`;
    } else {
      line += next;
    }
  }
  if (line !== indent) lines.push(line);
  return lines.join("\n");
}

const signed = (diff: MapDiff): string =>
  `+${diff.added.length} -${diff.removed.length}${diff.changed.length ? ` ~${diff.changed.length}` : ""}`;

/** Added, removed and changed names of one table, under its heading line. */
function renderMapDiff(
  title: string,
  diff: MapDiff,
  detail: (value: string) => string = () => "",
): string[] {
  const lines = [`${title}: ${diff.before} -> ${diff.after} (${signed(diff)})`];
  for (const entry of diff.added) {
    lines.push(`  + ${entry.name}${detail(entry.value)}`);
  }
  for (const entry of diff.removed) {
    lines.push(`  - ${entry.name}${detail(entry.value)}`);
  }
  for (const change of diff.changed) {
    lines.push(`  ~ ${change.name}: ${change.before} => ${change.after}`);
  }
  return lines;
}

function renderGroup(title: string, names: readonly string[]): string[] {
  return names.length === 0
    ? [`  ${title}: none`]
    : [`  ${title} (${names.length}):`, wrapped(names)];
}

function renderDiff(report: DiffReport): string {
  const { schema, gaps, signature } = report;
  const lines = [
    `Comparing ${report.previous} -> ${report.current}`,
    `Signature: both bundles pass codesign --verify --deep --strict; TeamIdentifier ${signature.current.teamIdentifier}.`,
    "",
    "Services and methods",
  ];
  for (const service of schema.services) {
    lines.push(
      ...renderMapDiff(
        `  ${service.service.replace(/^aiserver\.v1\./, "")}`,
        service,
        (value) => ` (${value})`,
      ).map((line, i) => (i === 0 ? line : `  ${line}`)),
    );
  }
  const { messages } = schema;
  lines.push(
    "",
    `Messages: ${messages.before} -> ${messages.after} (+${messages.added.length} -${messages.removed.length} ~${messages.changed.length})`,
    ...renderGroup("added", messages.added),
    ...renderGroup("removed", messages.removed),
  );
  for (const message of messages.changed) {
    lines.push(`  ~ ${message.name}`);
    for (const field of message.fields) lines.push(`      ${field}`);
  }
  lines.push(
    "",
    ...renderMapDiff("Bot tools", schema.tools),
    "",
    ...renderMapDiff(
      "Box Gateway methods",
      schema.gateway,
      (value) => ` (${value})`,
    ),
    "",
    `Client gates: ${schema.gates.before} -> ${schema.gates.after} (${signed(schema.gates)})`,
    ...renderGroup(
      "added",
      schema.gates.added.map((entry) => `${entry.name} [${entry.value}]`),
    ),
    ...renderGroup(
      "removed",
      schema.gates.removed.map((entry) => entry.name),
    ),
  );
  for (const change of schema.gates.changed) {
    lines.push(`  ~ ${change.name}: ${change.before} => ${change.after}`);
  }
  const total =
    gaps.methodsMissingFromCatalog.length +
    gaps.catalogMethodsGone.length +
    gaps.toolsMissingFromCatalog.length;
  lines.push(
    "",
    `Catalog coverage gaps: ${total === 0 ? "none" : total}`,
    ...renderGroup(
      "GrokBotService methods missing from the catalog",
      gaps.methodsMissingFromCatalog,
    ),
    ...renderGroup(
      "Catalog methods gone from GrokBotService",
      gaps.catalogMethodsGone,
    ),
    ...renderGroup(
      "Registry tools missing from the catalog",
      gaps.toolsMissingFromCatalog,
    ),
  );
  const unresolved = report.unresolved.previous + report.unresolved.current;
  if (unresolved > 0) {
    lines.push(
      "",
      `Note: ${unresolved} message reference(s) did not resolve to a name; their fields compare as "?".`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The build `--current` names; undefined when the feed has nothing newer than `previous`. */
async function resolveCurrent(
  option: string,
  previous: string,
): Promise<CurrentApp | undefined> {
  if (option !== "latest") {
    if (option === previous) {
      throw new Error(
        `The current version is the previous version (${previous}); pass --previous.`,
      );
    }
    return { version: option, url: releaseZipUrl(option) };
  }
  const latest = await fetchLatestBuild(previous);
  if (latest === undefined) return undefined;
  switch (compareVersions(latest.version, previous)) {
    case 1:
      return latest;
    case undefined:
      throw new Error(
        `Cannot compare the feed's version ${latest.version} with ${previous}.`,
      );
    default:
      return undefined;
  }
}

/** `--diff --current`: compare a release (the feed's newest, or a named one) with the previous. */
async function mainCurrent(
  options: Options & { readonly current: string },
  catalog: unknown,
  catalogVersion: string,
): Promise<number> {
  const previous = options.previous ?? catalogVersion;
  const current = await resolveCurrent(options.current, previous);
  const diff = current && (await compareApps(previous, current, catalog));
  if (diff && options.summary !== undefined) {
    await writeFile(options.summary, renderSummary(diff));
  }
  if (options.json) {
    const result = {
      catalog: catalogVersion,
      previous,
      current: current
        ? {
            source: options.current === "latest" ? "feed" : "named",
            version: current.version,
          }
        : null,
      diff: diff ?? null,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `Catalog:       ${catalogVersion}\nPrevious:      ${previous}\n`,
  );
  if (!diff) {
    process.stdout.write(
      `The update feed has nothing newer than ${previous}.\n`,
    );
    return 0;
  }
  process.stdout.write(`Current:       ${diff.current}\n\n${renderDiff(diff)}`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  const catalog: unknown = JSON.parse(await readFile(catalogUrl, "utf8"));
  const catalogVersion = parseCatalogAppVersion(catalog);
  if (options.current !== undefined) {
    return mainCurrent(
      { ...options, current: options.current },
      catalog,
      catalogVersion,
    );
  }
  const appPath = options.app ?? INSTALLED_APP_PATH;
  const installed = await readBundleVersion(appPath);
  const relation = relate(installed, catalogVersion);
  const summary = {
    installed: installed ?? null,
    catalog: catalogVersion,
    relation,
  };

  let diff: DiffReport | undefined;
  if (options.diff) {
    if (installed === undefined) {
      throw new Error(`No Grok Bot app found at ${appPath}; pass --app.`);
    }
    const previous = options.previous ?? catalogVersion;
    if (previous === installed) {
      throw new Error(
        `The previous version is the installed version (${installed}); pass --previous.`,
      );
    }
    diff = await compareApps(
      previous,
      { version: installed, path: appPath },
      catalog,
    );
    if (options.summary !== undefined) {
      await writeFile(options.summary, renderSummary(diff));
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, diff }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `Installed app: ${installed ?? "not found"} (${appPath})\nCatalog:       ${catalogVersion}\n${RELATION_TEXT[relation]}\n`,
  );
  if (diff) process.stdout.write(`\n${renderDiff(diff)}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`check:app: ${message}\n`);
  const code = member(error, "code");
  if (
    error instanceof UsageError ||
    (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))
  ) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}
