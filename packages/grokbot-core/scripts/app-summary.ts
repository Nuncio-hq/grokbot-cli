import type { CatalogGaps, MapDiff, SchemaDiff } from "./app-schema.js";

/** What one app-to-app comparison found; the text report and the summary render it. */
export interface DiffReport {
  readonly previous: string;
  readonly current: string;
  readonly signature: {
    readonly previous: Signature;
    readonly current: Signature;
  };
  readonly schema: SchemaDiff;
  readonly gaps: CatalogGaps;
  /** Message references no bundle let us resolve to a name, per app. */
  readonly unresolved: { readonly previous: number; readonly current: number };
}

export interface Signature {
  readonly verified: boolean;
  readonly teamIdentifier: string | undefined;
  /** What `codesign --verify` said, when it failed. */
  readonly problem?: string;
}

/** GitHub caps an issue body at 65,536 characters; lists stop well short of that. */
const LIST_LIMIT = 80;

const mapNames = (diff: MapDiff): { added: string[]; removed: string[] } => ({
  added: diff.added.map((entry) => entry.name),
  removed: diff.removed.map((entry) => entry.name),
});

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, LIST_LIMIT).map((name) => `\`${name}\``);
  const more = names.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

interface Section {
  readonly title: string;
  readonly before: number;
  readonly after: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

function sections(schema: SchemaDiff): Section[] {
  const fromMap = (title: string, diff: MapDiff): Section => ({
    title,
    before: diff.before,
    after: diff.after,
    ...mapNames(diff),
    changed: diff.changed.map((change) => change.name),
  });
  return [
    ...schema.services.map((service) =>
      fromMap(
        `${service.service.replace(/^aiserver\.v1\./, "")} methods`,
        service,
      ),
    ),
    {
      title: "Messages",
      before: schema.messages.before,
      after: schema.messages.after,
      added: schema.messages.added,
      removed: schema.messages.removed,
      changed: schema.messages.changed.map((message) => message.name),
    },
    fromMap("Bot tools", schema.tools),
    fromMap("Box Gateway methods", schema.gateway),
    fromMap("Client gates", schema.gates),
  ];
}

/**
 * A short Markdown summary of a comparison for an issue body: counts per section, the
 * catalog gaps and the added and removed names. Only names from the app's public schema.
 */
export function renderSummary(report: DiffReport): string {
  const { schema, gaps } = report;
  const all = sections(schema);
  const lines = [
    `Grok Bot **${report.current}** is available (compared with ${report.previous}).`,
    "",
    "Both bundles pass `codesign --verify --deep --strict` and share a TeamIdentifier.",
    "",
    "| Section | Before | After | Added | Removed | Changed |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...all.map(
      (s) =>
        `| ${s.title} | ${s.before} | ${s.after} | ${s.added.length} | ${s.removed.length} | ${s.changed.length} |`,
    ),
    "",
  ];
  const gapTotal =
    gaps.methodsMissingFromCatalog.length +
    gaps.catalogMethodsGone.length +
    gaps.toolsMissingFromCatalog.length;
  lines.push(
    `Catalog gaps: ${gapTotal === 0 ? "none" : gapTotal}`,
    ...(
      [
        [
          "GrokBotService methods missing from the catalog",
          gaps.methodsMissingFromCatalog,
        ],
        ["Catalog methods gone from GrokBotService", gaps.catalogMethodsGone],
        [
          "Registry tools missing from the catalog",
          gaps.toolsMissingFromCatalog,
        ],
      ] as const
    )
      .filter(([, names]) => names.length > 0)
      .map(([title, names]) => `- ${title}: ${nameList(names)}`),
    "",
  );
  for (const s of all) {
    if (s.added.length + s.removed.length + s.changed.length === 0) continue;
    lines.push(`### ${s.title}`);
    if (s.added.length > 0) lines.push(`- Added: ${nameList(s.added)}`);
    if (s.removed.length > 0) lines.push(`- Removed: ${nameList(s.removed)}`);
    if (s.changed.length > 0) lines.push(`- Changed: ${nameList(s.changed)}`);
    lines.push("");
  }
  if (
    all.every((s) => s.added.length + s.removed.length + s.changed.length === 0)
  ) {
    lines.push("No schema changes between the two builds.", "");
  }
  lines.push(
    `Reproduce with \`bun run check:app --diff --current ${report.current} --previous ${report.previous}\`, then update the catalog.`,
  );
  return `${lines.join("\n")}\n`;
}
