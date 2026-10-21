import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type Command,
  type CommandInput,
  isCommandName,
  listCommands,
} from "./command-catalog.js";
import { commandJsonSchema, parseCommandInput } from "./command-input.js";
import {
  BACKGROUND_COMPOSER_METHOD_SAFETY,
  DASHBOARD_METHOD_SAFETY,
  GATEWAY_METHOD_SAFETY,
} from "./method-safety.js";

describe("listCommands", () => {
  it("lists the Phase 01 commands first, in a stable order", () => {
    expect(
      listCommands()
        .slice(0, 7)
        .map((command) => command.name),
    ).toStrictEqual([
      "agents",
      "team",
      "ask",
      "send",
      "wait",
      "tail",
      "interrupt",
    ]);
  });
});

describe("isCommandName", () => {
  it("narrows catalog names and rejects everything else", () => {
    expect(
      ["ask", "interrupt", "toString", "", "__proto__"].map(isCommandName),
    ).toStrictEqual([true, true, false, false, false]);
  });
});

describe("commandJsonSchema", () => {
  it("renders ask as an MCP inputSchema", () => {
    expect(commandJsonSchema("ask")).toStrictEqual({
      type: "object",
      properties: {
        text: { type: "string", description: "Message to send to the agent" },
        timeout: {
          type: "integer",
          description: "Seconds to wait before giving up",
          default: 600,
          minimum: 1,
        },
        agent: {
          type: "string",
          description: expect.any(String),
        },
        json: {
          type: "boolean",
          description: "Return machine-readable JSON",
          default: false,
        },
      },
      required: ["text"],
      additionalProperties: false,
    });
  });

  it("omits required when a command has no required params", () => {
    expect(commandJsonSchema("tail")).toStrictEqual({
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Number of recent entries to read",
          default: 15,
          minimum: 1,
        },
        agent: {
          type: "string",
          description: expect.any(String),
        },
        json: {
          type: "boolean",
          description: "Return machine-readable JSON",
          default: false,
        },
      },
      additionalProperties: false,
    });
  });
});

describe("parseCommandInput", () => {
  it("fills defaults for omitted params", () => {
    expect(parseCommandInput("ask", { text: "ping" })).toStrictEqual({
      ok: true,
      input: { text: "ping", timeout: 600, json: false },
    });
  });

  it("coerces numeric strings from the CLI to integers", () => {
    expect(
      parseCommandInput("tail", {
        limit: "20",
        agent: "Primary Test",
        json: true,
      }),
    ).toStrictEqual({
      ok: true,
      input: { limit: 20, agent: "Primary Test", json: true },
    });
  });

  it("reports a missing required param", () => {
    expect(parseCommandInput("ask", {})).toStrictEqual({
      ok: false,
      errors: ['ask: missing required parameter "text"'],
    });
    expect(parseCommandInput("send", { text: "   " })).toStrictEqual({
      ok: false,
      errors: ['send: missing required parameter "text"'],
    });
  });

  it("reports an unknown flag with the accepted names", () => {
    expect(
      parseCommandInput("ask", { text: "hi", tiemout: "5" }),
    ).toStrictEqual({
      ok: false,
      errors: [
        'ask: unknown parameter "tiemout" (expected one of: text, timeout, agent, json)',
      ],
    });
  });

  it("collects every wrong type in one pass", () => {
    expect(
      parseCommandInput("wait", { job: 42, timeout: "1.5", json: "yes" }),
    ).toStrictEqual({
      ok: false,
      errors: [
        'wait: parameter "job" must be a string, got 42',
        'wait: parameter "timeout" must be an integer, got "1.5"',
        'wait: parameter "json" must be a boolean, got "yes"',
      ],
    });
  });

  it("enforces integer minimums", () => {
    expect(parseCommandInput("tail", { limit: "0" })).toStrictEqual({
      ok: false,
      errors: ['tail: parameter "limit" must be at least 1, got "0"'],
    });
  });

  it("derives input types from the catalog", () => {
    expectTypeOf<CommandInput<"ask">>().toEqualTypeOf<{
      readonly text: string;
      readonly timeout: number;
      readonly json: boolean;
      readonly agent?: string;
    }>();
    // @ts-expect-error a misspelled param name does not compile
    expectTypeOf<CommandInput<"ask">>().toHaveProperty("tiemout");
  });
});

describe("catalog against docs/grokbot-tools-and-api.json", () => {
  const catalog: { methods: { name: string; safety: string }[] } = JSON.parse(
    readFileSync(
      new URL("../../../docs/grokbot-tools-and-api.json", import.meta.url),
      "utf8",
    ),
  );
  const safetyOf = new Map(catalog.methods.map((m) => [m.name, m.safety]));
  const RANK: Readonly<Record<string, number>> = {
    "read-only": 0,
    writes: 1,
    destructive: 2,
    sensitive: 2,
  };
  // staff-only and unknown tags outrank every command tag, so such a command always fails.
  const rank = (safety: string | undefined) =>
    (safety === undefined ? undefined : RANK[safety]) ??
    Number.POSITIVE_INFINITY;
  const methodTags = (command: Command) => [
    ...command.methods.map((m) => safetyOf.get(m)),
    ...(command.gatewayMethods ?? []).map((m) => GATEWAY_METHOD_SAFETY[m]),
    ...(command.dashboardMethods ?? []).map((m) => DASHBOARD_METHOD_SAFETY[m]),
    ...(command.composerMethods ?? []).map(
      (m) => BACKGROUND_COMPOSER_METHOD_SAFETY[m],
    ),
    ...(command.firesWebhook ? ["writes"] : []),
  ];

  it("lists at least one RPC method per command, each known to the API catalog", () => {
    expect(safetyOf.get("ListGrokBotAgents")).toBe("read-only");
    expect(
      listCommands()
        .filter((command) => methodTags(command).length === 0)
        .map((command) => command.name),
    ).toStrictEqual([]);
    expect(
      listCommands().flatMap((command) =>
        command.methods.filter((method) => !safetyOf.has(method)),
      ),
    ).toStrictEqual([]);
  });

  it("tags each command with its worst method, so no read-only command writes", () => {
    expect(
      listCommands()
        .filter(
          (command) =>
            rank(command.safety) !== Math.max(...methodTags(command).map(rank)),
        )
        .map((command) => command.name),
    ).toStrictEqual([]);
  });
});
