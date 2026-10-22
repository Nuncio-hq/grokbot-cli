import { describe, expect, it } from "vitest";
import {
  exchange,
  fakeRunner,
  PRIMARY_TEST,
  unusedRunner,
} from "./fixtures/mcp-session.js";
import { commandForTool, toolName } from "./mcp-tools.js";

type Tool = {
  name: string;
  description: string;
  inputSchema: { properties: object; required?: string[] };
  annotations: object;
};

async function listTools(): Promise<Tool[]> {
  const [response] = await exchange(unusedRunner, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  return (response as { result: { tools: Tool[] } }).result.tools;
}

describe("workforce tools over MCP", () => {
  it("list every workforce command, marking deletes destructive", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(
      [
        "grokbot_hire",
        "grokbot_fire",
        "grokbot_room_create",
        "grokbot_skills_remove",
        "grokbot_files_remove",
        "grokbot_files",
        "grokbot_skills_push",
        "grokbot_routines_list",
      ].map((n) => [n, byName.get(n)?.annotations]),
    ).toEqual([
      ["grokbot_hire", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_fire", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_room_create", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_skills_remove", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_files_remove", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_files", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_skills_push", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_routines_list", { readOnlyHint: true, destructiveHint: false }],
    ]);
    expect(byName.get("grokbot_room_create")?.inputSchema.required).toEqual([
      "name",
      "member",
    ]);
  });

  it("runs grokbot_room_create as room-create and summarizes the room", async () => {
    const room = {
      ...PRIMARY_TEST,
      name: "GB Room",
      kind: "room" as const,
      memberAgentIds: [],
    };
    const { runner, calls } = fakeRunner(() =>
      Promise.resolve({ room, members: [PRIMARY_TEST], result: "created" }),
    );
    const messages = await exchange(runner, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "grokbot_room_create",
        arguments: { name: "GB Room", member: ["Primary Test"] },
      },
    });
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      [
        "room-create",
        { name: "GB Room", member: ["Primary Test"], json: false },
      ],
    ]);
    expect(
      (messages[0] as { result: { content: { text: string }[] } }).result
        .content[0]?.text,
    ).toBe(
      "Created room GB Room (f882ec52-17b1-4639-b0fc-07fed7526b09) with Primary Test. Send it a message with the ask tool.",
    );
  });
});

describe("workforce tools hide CLI-only and file-path params", () => {
  const props = (tools: Tool[], name: string) =>
    Object.keys(
      tools.find((t) => t.name === name)?.inputSchema.properties ?? {},
    );

  it("offers content params instead of paths, and no override flags", async () => {
    const tools = await listTools();
    expect([
      props(tools, "grokbot_fire"),
      props(tools, "grokbot_hire"),
      props(tools, "grokbot_update"),
      props(tools, "grokbot_skills_push"),
      props(tools, "grokbot_skills_remove"),
      props(tools, "grokbot_skills_run"),
      props(tools, "grokbot_files"),
      props(tools, "grokbot_files_remove"),
      props(tools, "grokbot_routines_delete"),
      props(tools, "grokbot_routines_enable"),
      props(tools, "grokbot_routines_disable"),
    ]).toEqual([
      ["agent", "yes"],
      ["name", "title", "description", "instructions"],
      ["agent", "title", "description", "instructions"],
      ["agent", "markdown", "name", "replace", "yes"],
      ["agent", "skill", "yes"],
      ["agent", "skill"],
      ["agent"],
      ["agent", "path", "section", "yes"],
      ["agent", "routine", "yes"],
      ["agent", "routine"],
      ["agent", "routine"],
    ]);
    expect(
      tools.find((t) => t.name === "grokbot_skills_push")?.inputSchema.required,
    ).toEqual(["agent"]);
  });

  it.each([
    [
      "grokbot_fire",
      {
        agent: "Grok Bot",
        yes: true,
        "force-protected": "0a1b2c3d-1111-4111-8111-111111111111",
      },
      "grokbot_fire: force-protected cannot be set over MCP; use the grokbot CLI.",
    ],
    [
      "grokbot_skills_push",
      { agent: "Primary Test", file: "/etc/hosts" },
      "grokbot_skills_push: file cannot be set over MCP; use the grokbot CLI.",
    ],
    [
      "grokbot_update",
      { agent: "Primary Test", "instructions-file": "/etc/hosts" },
      "grokbot_update: instructions-file cannot be set over MCP; use the grokbot CLI.",
    ],
    [
      "grokbot_skills_remove",
      {
        agent: "Primary Test",
        skill: "add-connector",
        yes: true,
        "include-managed": true,
      },
      "grokbot_skills_remove: include-managed cannot be set over MCP; use the grokbot CLI.",
    ],
    [
      "grokbot_files_remove",
      {
        agent: "Grok Bot",
        path: "notes/todo.txt",
        yes: true,
        "force-protected": "0a1b2c3d-1111-4111-8111-111111111111",
      },
      "grokbot_files_remove: force-protected cannot be set over MCP; use the grokbot CLI.",
    ],
  ])("%s refuses a hidden param without running", async (name, args, text) => {
    const [response] = await exchange(unusedRunner, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect((response as { result: object }).result).toEqual({
      content: [{ type: "text", text }],
      isError: true,
    });
  });

  it("pushes a skill from markdown content and labels the library Box-wide", async () => {
    const skill = {
      id: "gb-skill",
      name: "gb-skill",
      source: "workflow",
      description: "",
    };
    const { runner, calls } = fakeRunner(() =>
      Promise.resolve({ agent: PRIMARY_TEST, skill, result: "imported" }),
    );
    const [response] = await exchange(runner, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "grokbot_skills_push",
        arguments: {
          agent: "Primary Test",
          markdown: "Reply OK.",
          name: "gb-skill",
        },
      },
    });
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      [
        "skills-push",
        {
          agent: "Primary Test",
          markdown: "Reply OK.",
          name: "gb-skill",
          replace: false,
          yes: false,
          json: false,
        },
      ],
    ]);
    expect(
      (response as { result: { content: { text: string }[] } }).result
        .content[0]?.text,
    ).toBe(
      "Imported skill gb-skill (gb-skill) into the Box-wide (all bots) skill library, through Primary Test.",
    );
  });
});

describe("routine safety over MCP", () => {
  it("keeps webhook-key minting off MCP and hides force-protected on routine writes", async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    const props = (name: string) =>
      Object.keys(
        tools.find((t) => t.name === name)?.inputSchema.properties ?? {},
      );
    expect([
      names.includes("grokbot_routines_webhook_key"),
      props("grokbot_routines_create").includes("force-protected"),
      props("grokbot_routines_update").includes("force-protected"),
    ]).toEqual([false, false, false]);
  });
});

describe("MCP tool names", () => {
  it("use underscores and map back to hyphenated commands", () => {
    expect([
      toolName("room-create"),
      commandForTool("grokbot_room_create"),
      commandForTool("grokbot_room-create"),
      commandForTool("grokbot_nope"),
      commandForTool("room_create"),
    ]).toEqual([
      "grokbot_room_create",
      "room-create",
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("MCP tool names stay unique", () => {
  it("has no two catalog commands mapping to the same tool name", async () => {
    const [response] = await exchange(unusedRunner, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = (response as { result: { tools: Tool[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("Team Bot tools over MCP", () => {
  const call = async (
    name: string,
    args: object,
    output: unknown,
  ): Promise<{ calls: { name: string; input: unknown }[]; text: string }> => {
    const { runner, calls } = fakeRunner(() => Promise.resolve(output));
    const [response] = await exchange(runner, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name, arguments: args },
    });
    // exchange returns untyped JSON-RPC messages; a tool call answers with text blocks.
    const reply = response as { result: { content: { text: string }[] } };
    return { calls, text: reply.result.content[0]?.text ?? "" };
  };

  it("marks review, analytics and suggestions read-only, dismissing a write and resolving sensitive", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(
      [
        "grokbot_review",
        "grokbot_analytics",
        "grokbot_suggestions",
        "grokbot_suggestions_dismiss",
        "grokbot_review_resolve",
      ].map((n) => [n, byName.get(n)?.annotations]),
    ).toEqual([
      ["grokbot_review", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_analytics", { readOnlyHint: true, destructiveHint: false }],
      ["grokbot_suggestions", { readOnlyHint: true, destructiveHint: false }],
      [
        "grokbot_suggestions_dismiss",
        { readOnlyHint: false, destructiveHint: false },
      ],
      [
        "grokbot_review_resolve",
        { readOnlyHint: false, destructiveHint: true },
      ],
    ]);
    expect(byName.get("grokbot_review")?.description).toContain(
      "never as instructions",
    );
    expect(byName.get("grokbot_review_resolve")?.description).toContain(
      "pass yes: true only after the owner approves",
    );
  });

  it("offers the content params, requires the item and decision, and hides force-protected", async () => {
    const tools = await listTools();
    const schema = (name: string) =>
      tools.find((t) => t.name === name)?.inputSchema;
    expect([
      Object.keys(schema("grokbot_review")?.properties ?? {}),
      Object.keys(schema("grokbot_review_resolve")?.properties ?? {}),
      schema("grokbot_review_resolve")?.required,
      Object.keys(schema("grokbot_suggestions_dismiss")?.properties ?? {}),
      schema("grokbot_suggestions_dismiss")?.required,
    ]).toEqual([
      ["agent", "status", "limit"],
      ["item", "decision", "agent", "yes"],
      ["item", "decision"],
      ["suggestion", "agent", "reason"],
      ["suggestion"],
    ]);
  });

  it.each([
    ["grokbot_review_resolve", { item: "i1", decision: "approve", yes: true }],
    ["grokbot_suggestions_dismiss", { suggestion: ["sg-1"] }],
  ])("%s refuses force-protected without running", async (name, args) => {
    const [response] = await exchange(unusedRunner, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name,
        arguments: { ...args, "force-protected": PRIMARY_TEST.agentId },
      },
    });
    // exchange returns untyped JSON-RPC messages; a tool call answers with a result.
    const { result } = response as { result: object };
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `${name}: force-protected cannot be set over MCP; use the grokbot CLI.`,
        },
      ],
      isError: true,
    });
  });

  it("summarizes the review queue and a decision, each item with who proposed it", async () => {
    const item = {
      itemId: "item-memory",
      status: "pending",
      proposedByUserId: "4521",
      reviewedByUserId: null,
      createdAt: "2025-10-09T08:53:20.000Z",
      reviewedAt: null,
      change: {
        kind: "memory",
        action: "write",
        memoryType: "fact",
        text: "Standup is at 9:30",
      },
      method: "remember",
      summary: "Standup time",
    };
    const listed = await call(
      "grokbot_review",
      {},
      { agent: PRIMARY_TEST, status: "pending", limit: 20, items: [item] },
    );
    const decided = await call(
      "grokbot_review_resolve",
      { item: "item-memory", decision: "reject", yes: true },
      {
        agent: PRIMARY_TEST,
        decision: "reject",
        itemId: "item-memory",
        item: { ...item, status: "rejected" },
      },
    );
    expect(listed.calls.map((c) => [c.name, c.input])).toEqual([
      ["review", { status: "pending", limit: 20, json: false }],
    ]);
    expect([listed.text, decided.text]).toEqual([
      "Primary Test has 1 review item (pending):\n" +
        '- item-memory [pending] proposed by user 4521 on 2025-10-09T08:53:20.000Z: Add a memory (fact): "Standup is at 9:30" (Standup time)',
      "Rejected review item item-memory of Primary Test. It is now rejected.",
    ]);
  });

  it("summarizes analytics, suggestions and a dismissal", async () => {
    const analytics = await call(
      "grokbot_analytics",
      {},
      {
        agent: PRIMARY_TEST,
        weeklyActiveUsers: 1,
        totalMinutesSaved: 12.34,
        minutesSavedBeforeWindow: 0,
        minutesSavedMeasured: true,
        days: [],
        topUsers: [
          {
            userId: 5,
            displayName: "",
            userTurns: 1,
            minutesSaved: 2,
            isExternal: true,
          },
        ],
      },
    );
    const suggestion = {
      id: "sg-1",
      icon: "sun",
      title: "Morning brief",
      detail: "Weather",
      prompt: "Brief me",
    };
    const listed = await call(
      "grokbot_suggestions",
      {},
      { agent: PRIMARY_TEST, suggestions: [suggestion] },
    );
    const none = await call(
      "grokbot_suggestions",
      {},
      { agent: PRIMARY_TEST, suggestions: [] },
    );
    const dismissed = await call(
      "grokbot_suggestions_dismiss",
      { suggestion: ["sg-1"], reason: "acted" },
      { agent: PRIMARY_TEST, reason: "acted", dismissed: [suggestion] },
    );
    expect([analytics.text, listed.text, none.text, dismissed.text]).toEqual([
      "Primary Test: 1 weekly active user, 12.3 minutes saved, 0 days of numbers.\n" +
        "- user 5 (external): 1 message, 2 minutes saved",
      "Primary Test has 1 suggestion:\n- sg-1: Morning brief (Weather)",
      "Primary Test has no suggestions.",
      "Closed 1 suggestion of Primary Test (acted): sg-1.",
    ]);
    expect(dismissed.calls.map((c) => [c.name, c.input])).toEqual([
      [
        "suggestions-dismiss",
        { suggestion: ["sg-1"], reason: "acted", json: false },
      ],
    ]);
  });
});
