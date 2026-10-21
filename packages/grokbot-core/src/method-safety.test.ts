import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import {
  assertGatewayMethodAllowed,
  assertMethodAllowed,
  parseMethodSafetyCatalog,
} from "./method-safety.js";
import { SERVER_METHOD_SAFETY } from "./method-safety-table.js";

const catalogUrl = new URL(
  "../../../docs/grokbot-tools-and-api.json",
  import.meta.url,
);

/** "allowed", or the error code of the refusal. */
function verdict(check: () => void): string {
  try {
    check();
    return "allowed";
  } catch (error) {
    return error instanceof GrokBotError ? error.code : "other";
  }
}

describe("assertMethodAllowed", () => {
  it.each([
    // read-only and writes need no confirmation
    ["ListGrokBotAgents", false, "allowed"],
    ["SendGrokBotUserMessage", false, "allowed"],
    // destructive, sensitive and staff-only need it
    ["DeleteGrokBotAgent", false, "safety"],
    ["DeleteGrokBotAgent", true, "allowed"],
    ["ResolveGrokBotCredentialRequest", false, "safety"],
    ["AdminDeleteGrokBotAgent", false, "safety"],
    // a method outside the catalog fails closed, inherited object keys included
    ["NotARealMethod", false, "safety"],
    ["NotARealMethod", true, "allowed"],
    ["constructor", false, "safety"],
    ["toString", false, "safety"],
    // a name that could address another path is refused even when confirmed
    ["../ListGrokBotAgents", true, "safety"],
    ["", true, "safety"],
  ])("%s with confirmed=%s is %s", (method, confirmed, expected) => {
    expect(verdict(() => assertMethodAllowed(method, confirmed))).toBe(
      expected,
    );
  });
});

describe("assertGatewayMethodAllowed", () => {
  it.each([
    ["listAgents", false, "allowed"],
    ["getMcpState", false, "allowed"],
    ["importAgentWorkflowText", false, "allowed"],
    ["deleteAgentWorkflow", false, "safety"],
    ["deleteAgentWorkflow", true, "allowed"],
    ["callMcpAppTool", false, "safety"],
    ["callMcpAppTool", true, "allowed"],
    // a method the Box Gateway table does not list fails closed
    ["getVncPassword", false, "safety"],
    ["ListGrokBotAgents", false, "safety"],
  ])("%s with confirmed=%s is %s", (method, confirmed, expected) => {
    expect(verdict(() => assertGatewayMethodAllowed(method, confirmed))).toBe(
      expected,
    );
  });
});

describe("parseMethodSafetyCatalog", () => {
  it("sorts methods by name and keeps their tags", () => {
    expect(
      parseMethodSafetyCatalog({
        methods: [
          { name: "Zed", safety: "writes", area: "x" },
          { name: "Alpha", safety: "read-only" },
        ],
      }),
    ).toEqual([
      ["Alpha", "read-only"],
      ["Zed", "writes"],
    ]);
  });

  it("rejects an unknown safety tag", () => {
    expect(() =>
      parseMethodSafetyCatalog({ methods: [{ name: "A", safety: "risky" }] }),
    ).toThrow('Method A has unknown safety tag "risky".');
  });

  it("rejects a duplicate method", () => {
    expect(() =>
      parseMethodSafetyCatalog({
        methods: [
          { name: "A", safety: "writes" },
          { name: "A", safety: "read-only" },
        ],
      }),
    ).toThrow("Method A appears twice in the catalog.");
  });

  it("matches the checked-in table, so catalog drift fails the suite", async () => {
    const catalog: unknown = JSON.parse(await readFile(catalogUrl, "utf8"));
    expect(Object.entries(SERVER_METHOD_SAFETY)).toEqual(
      parseMethodSafetyCatalog(catalog),
    );
  });
});
