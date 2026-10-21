import { describe, expect, expectTypeOf, it } from "vitest";
import { type InputOf, mergeCommandGroups } from "./command-catalog.js";
import { paramsJsonSchema, parseParams } from "./command-input.js";
import {
  type CommandSpec,
  confirmedFor,
  JSON_PARAM,
  YES_PARAM,
} from "./command-spec.js";
import { GrokBotError } from "./contracts.js";

const MEMBERS = {
  type: "string-list",
  description: "Agents in the room",
  required: true,
} as const;
const TAGS = { type: "string-list", description: "Optional tags" } as const;
const ROOM_PARAMS = { members: MEMBERS, tags: TAGS, json: JSON_PARAM } as const;

const spec = (summary: string): CommandSpec => ({
  summary,
  safety: "read-only",
  methods: ["ListGrokBotAgents"],
  params: {},
});

describe("mergeCommandGroups", () => {
  it("joins groups in dispatch, workforce, governance, inbox order", () => {
    const merged = mergeCommandGroups(
      { agents: spec("a") },
      { hire: spec("h"), fire: spec("f") },
      { approve: spec("p") },
      { inbox: spec("i") },
    );
    expect(Object.keys(merged)).toStrictEqual([
      "agents",
      "hire",
      "fire",
      "approve",
      "inbox",
    ]);
  });

  it("refuses a command name that two groups define", () => {
    expect(() =>
      mergeCommandGroups(
        { agents: spec("a") },
        { room: spec("r") },
        { room: spec("r2") },
        { inbox: spec("i") },
      ),
    ).toThrow(
      new Error(
        'Command "room" is defined in both the workforce and governance groups.',
      ),
    );
  });
});

describe("string-list params", () => {
  it("parse an array of strings and stay absent when empty", () => {
    expect(
      parseParams("room", ROOM_PARAMS, {
        members: ["Primary Test", "Staff Test"],
      }),
    ).toStrictEqual({
      ok: true,
      input: { members: ["Primary Test", "Staff Test"], json: false },
    });
    expect(parseParams("room", ROOM_PARAMS, { members: [] })).toStrictEqual({
      ok: false,
      errors: ['room: missing required parameter "members"'],
    });
  });

  it("reject a bare string, non-strings, and blank items", () => {
    expect(
      parseParams("room", ROOM_PARAMS, {
        members: "Primary Test",
        tags: ["ok", 7, " "],
      }),
    ).toStrictEqual({
      ok: false,
      errors: [
        'room: parameter "members" must be a list of non-blank strings, got "Primary Test"',
        'room: parameter "tags" must be a list of non-blank strings, got ["ok",7," "]',
      ],
    });
  });

  it("render as a JSON Schema array of strings", () => {
    expect(paramsJsonSchema(ROOM_PARAMS)).toStrictEqual({
      type: "object",
      properties: {
        members: {
          type: "array",
          items: { type: "string" },
          description: "Agents in the room",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags",
        },
        json: {
          type: "boolean",
          description: "Return machine-readable JSON",
          default: false,
        },
      },
      required: ["members"],
      additionalProperties: false,
    });
  });

  it("type as readonly string[] in the parsed input", () => {
    expectTypeOf<InputOf<typeof ROOM_PARAMS>>().toEqualTypeOf<{
      readonly members: readonly string[];
      readonly json: boolean;
      readonly tags?: readonly string[];
    }>();
  });
});

describe("confirmedFor", () => {
  it("never confirms read-only or writes commands, even with yes", () => {
    expect([
      confirmedFor("tail", "read-only", {}),
      confirmedFor("hire", "writes", { yes: true }),
    ]).toStrictEqual([false, false]);
  });

  it("confirms a destructive or sensitive command run with yes", () => {
    expect([
      confirmedFor("fire", "destructive", { yes: true }),
      confirmedFor("approve", "sensitive", { yes: true }),
    ]).toStrictEqual([true, true]);
  });

  it("refuses a destructive or sensitive command without yes", () => {
    const refusal = (name: string) =>
      new GrokBotError(
        "safety",
        `${name} changes or deletes live data. Re-run with --yes.`,
      );
    expect(() => confirmedFor("fire", "destructive", { yes: false })).toThrow(
      refusal("fire"),
    );
    expect(() => confirmedFor("approve", "sensitive", {})).toThrow(
      refusal("approve"),
    );
  });

  it("requires destructive and sensitive specs to declare yes", () => {
    const fire = {
      summary: "Delete an agent",
      safety: "destructive",
      methods: ["DeleteGrokBotAgent"],
      params: { yes: YES_PARAM },
    } as const satisfies CommandSpec;
    expectTypeOf(fire).toExtend<CommandSpec>();
    expectTypeOf({
      ...fire,
      params: { json: JSON_PARAM },
    }).not.toExtend<CommandSpec>();
  });
});
