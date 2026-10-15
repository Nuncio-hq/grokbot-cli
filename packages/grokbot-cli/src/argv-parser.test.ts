import type { Command } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { argvParser } from "./argv-parser.js";
import { commandHelp } from "./help.js";

// A Phase 02 room command stand-in. It borrows the name "agents" because Command names come from the catalog.
const ROOM = {
  name: "agents",
  summary: "Create a room",
  safety: "writes",
  methods: ["CreateGrokBotRoom"],
  params: {
    title: {
      type: "string",
      description: "Room title",
      required: true,
      position: 0,
    },
    member: {
      type: "string-list",
      description: "Agent to add",
      required: true,
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
} as const satisfies Command;

const parse = argvParser([ROOM]);

describe("string-list flags", () => {
  it("accumulate repeated flags and split comma-separated values", () => {
    expect(
      parse([
        "agents",
        "Launch",
        "--member",
        "Primary Test",
        "--member=Staff Test, Test-Dev-1,",
      ]),
    ).toStrictEqual({
      kind: "run",
      command: ROOM,
      raw: {
        title: "Launch",
        member: ["Primary Test", "Staff Test", "Test-Dev-1"],
      },
      json: false,
    });
  });

  it("still needs a value after the flag", () => {
    expect(parse(["agents", "Launch", "--member"])).toStrictEqual({
      kind: "usage-error",
      command: ROOM,
      errors: ["--member needs a value"],
    });
  });

  it("show as a repeatable flag in command help", () => {
    expect(commandHelp(ROOM)).toBe(
      [
        "Create a room",
        "",
        "Usage: grokbot agents <title> [--member <string>...] [--json]",
        "",
        "Arguments:",
        "  <title>  Room title (required)",
        "",
        "Flags:",
        "  --member <string>...  Agent to add (required, repeat or comma-separate)",
        "  --json                JSON output (default: false)",
        "",
      ].join("\n"),
    );
  });
});

describe("argvParser", () => {
  it("refuses two commands that give one flag two meanings", () => {
    const clash = {
      ...ROOM,
      name: "team",
      params: { member: { type: "string", description: "One agent" } },
    } as const satisfies Command;
    expect(() => argvParser([ROOM, clash])).toThrow(
      new Error("catalog flag --member has two meanings"),
    );
  });
});
