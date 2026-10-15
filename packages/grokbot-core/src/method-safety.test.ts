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

function verdict(check: () => void): string {
  try {
    check();
    return "allowed";
  } catch (error) {
    return error instanceof GrokBotError
      ? `${error.code}: ${error.message}`
      : "other";
  }
}

describe("assertMethodAllowed", () => {
  it.each([
    ["ListGrokBotAgents", false, "allowed"],
    ["SendGrokBotUserMessage", false, "allowed"],
    [
      "DeleteGrokBotAgent",
      false,
      "safety: DeleteGrokBotAgent is tagged destructive. Pass confirmed: true only after the owner approves.",
    ],
    ["DeleteGrokBotAgent", true, "allowed"],
    [
      "ResolveGrokBotCredentialRequest",
      false,
      "safety: ResolveGrokBotCredentialRequest is tagged sensitive. Pass confirmed: true only after the owner approves.",
    ],
    [
      "AdminDeleteGrokBotAgent",
      false,
      "safety: AdminDeleteGrokBotAgent is tagged staff-only. Pass confirmed: true only after the owner approves.",
    ],
    [
      "NotARealMethod",
      false,
      "safety: NotARealMethod is not in the safety catalog. Pass confirmed: true only after the owner approves.",
    ],
    ["NotARealMethod", true, "allowed"],
    [
      "constructor",
      false,
      "safety: constructor is not in the safety catalog. Pass confirmed: true only after the owner approves.",
    ],
    [
      "toString",
      false,
      "safety: toString is not in the safety catalog. Pass confirmed: true only after the owner approves.",
    ],
    [
      "../ListGrokBotAgents",
      true,
      'safety: "../ListGrokBotAgents" is not a valid method name.',
    ],
    ["", true, 'safety: "" is not a valid method name.'],
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
    [
      "deleteAgentWorkflow",
      false,
      "safety: deleteAgentWorkflow is tagged destructive. Pass confirmed: true only after the owner approves.",
    ],
    [
      "injectChromeCookies",
      false,
      "safety: injectChromeCookies is tagged sensitive. Pass confirmed: true only after the owner approves.",
    ],
    ["injectChromeCookies", true, "allowed"],
    [
      "getVncPassword",
      false,
      "safety: getVncPassword is not in the safety catalog. Pass confirmed: true only after the owner approves.",
    ],
    [
      "ListGrokBotAgents",
      false,
      "safety: ListGrokBotAgents is not in the safety catalog. Pass confirmed: true only after the owner approves.",
    ],
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
