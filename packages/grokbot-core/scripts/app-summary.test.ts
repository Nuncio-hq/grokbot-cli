import { describe, expect, it } from "vitest";
import type { MapDiff } from "./app-schema.js";
import { type DiffReport, renderSummary } from "./app-summary.js";

const none: MapDiff = {
  before: 3,
  after: 3,
  added: [],
  removed: [],
  changed: [],
};
const signed = { verified: true, teamIdentifier: "TEAM123456" } as const;

function report(overrides: Partial<DiffReport> = {}): DiffReport {
  return {
    previous: "0.72.1",
    current: "0.73.0",
    signature: { previous: signed, current: signed },
    schema: {
      services: [
        {
          service: "aiserver.v1.GrokBotService",
          before: 10,
          after: 11,
          added: [{ name: "NewMethod", value: "Req -> Res" }],
          removed: [],
          changed: [],
        },
      ],
      messages: {
        before: 100,
        after: 102,
        added: ["NewRequest", "NewResponse"],
        removed: [],
        changed: [{ name: "PingRequest", fields: ["+ 3 extra"] }],
      },
      tools: { ...none, removed: [{ name: "old_tool", value: "" }], after: 2 },
      gateway: none,
      gates: none,
    },
    gaps: {
      methodsMissingFromCatalog: ["NewMethod"],
      catalogMethodsGone: [],
      toolsMissingFromCatalog: [],
    },
    unresolved: { previous: 0, current: 0 },
    ...overrides,
  };
}

describe("renderSummary", () => {
  const text = renderSummary(report());

  it("names both versions", () => {
    expect(text).toContain("0.73.0");
    expect(text).toContain("0.72.1");
  });

  it("counts every section in a table row", () => {
    expect(text).toContain("| GrokBotService methods | 10 | 11 | 1 | 0 | 0 |");
    expect(text).toContain("| Messages | 100 | 102 | 2 | 0 | 1 |");
    expect(text).toContain("| Bot tools | 3 | 2 | 0 | 1 | 0 |");
    expect(text).toContain("| Box Gateway methods | 3 | 3 | 0 | 0 | 0 |");
    expect(text).toContain("| Client gates | 3 | 3 | 0 | 0 | 0 |");
  });

  it("lists the added, removed and changed names and the catalog gaps", () => {
    expect(text).toContain("`NewMethod`");
    expect(text).toContain("`NewRequest`, `NewResponse`");
    expect(text).toContain("`old_tool`");
    expect(text).toContain("`PingRequest`");
    expect(text).toMatch(/Catalog gaps: 1\b/);
  });

  it("leaves out sections without changes and field details", () => {
    expect(text).not.toContain("### Box Gateway methods");
    expect(text).not.toContain("+ 3 extra");
  });

  it("does not print the team identifier", () => {
    expect(text).not.toContain("TEAM123456");
  });

  it("says so when nothing changed and there are no gaps", () => {
    const quiet = renderSummary(
      report({
        schema: {
          services: [],
          messages: {
            before: 1,
            after: 1,
            added: [],
            removed: [],
            changed: [],
          },
          tools: none,
          gateway: none,
          gates: none,
        },
        gaps: {
          methodsMissingFromCatalog: [],
          catalogMethodsGone: [],
          toolsMissingFromCatalog: [],
        },
      }),
    );
    expect(quiet).toContain("No schema changes");
    expect(quiet).toContain("Catalog gaps: none");
  });

  it("caps long lists so the issue body stays small", () => {
    const names = Array.from({ length: 5000 }, (_, i) => `Message${i}`);
    const big = renderSummary(
      report({
        schema: {
          ...report().schema,
          messages: {
            before: 0,
            after: 5000,
            added: names,
            removed: [],
            changed: [],
          },
        },
      }),
    );
    expect(big.length).toBeLessThan(60_000);
    expect(big).toContain("and 4920 more");
  });
});
