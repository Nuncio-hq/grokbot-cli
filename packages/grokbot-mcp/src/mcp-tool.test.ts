import type { Command } from "grokbot-core";
import { describe, expect, it } from "vitest";
import { mcpTool } from "./mcp-tools.js";

const YES = {
  type: "boolean",
  description: "Confirm a command that changes or deletes live data",
  default: false,
} as const;

// Phase 02 and 03 stand-ins. They borrow the name "agents" because Command names come from the catalog.
const FIRE = {
  name: "agents",
  summary: "Delete an agent",
  safety: "destructive",
  methods: ["DeleteGrokBotAgent"],
  params: {
    agent: { type: "string", description: "Agent to delete" },
    yes: YES,
    json: { type: "boolean", description: "JSON output", default: false },
  },
} as const satisfies Command;
const APPROVE = {
  ...FIRE,
  summary: "Approve a pending card",
  safety: "sensitive",
  methods: ["ResolveGrokBotAutoReviewApproval"],
  params: { yes: YES },
} as const satisfies Command;
const ROOM = {
  ...FIRE,
  summary: "Create a room",
  safety: "writes",
  methods: ["CreateGrokBotRoom"],
  params: {
    member: { type: "string-list", description: "Agent to add" },
  },
} as const satisfies Command;

describe("mcpTool", () => {
  it("marks a destructive command and documents its yes param", () => {
    expect(mcpTool(FIRE)).toStrictEqual({
      name: "grokbot_agents",
      description:
        "Delete an agent. Destructive: deletes live GrokBot data; pass yes: true only after the owner approves.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent to delete" },
          yes: {
            type: "boolean",
            description: "Confirm a command that changes or deletes live data",
            default: false,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  });

  it("marks a sensitive command as destructive for MCP clients", () => {
    const tool = mcpTool(APPROVE);
    expect([tool.description, tool.annotations]).toStrictEqual([
      "Approve a pending card. Sensitive: acts with the owner's authority; pass yes: true only after the owner approves.",
      { readOnlyHint: false, destructiveHint: true },
    ]);
  });

  it("renders a string-list param as an array of strings", () => {
    expect(mcpTool(ROOM).inputSchema.properties).toStrictEqual({
      member: {
        type: "array",
        items: { type: "string" },
        description: "Agent to add",
      },
    });
  });
});
