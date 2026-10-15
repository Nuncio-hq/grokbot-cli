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
        "grokbot_skills_push",
        "grokbot_routines_list",
      ].map((n) => [n, byName.get(n)?.annotations]),
    ).toEqual([
      ["grokbot_hire", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_fire", { readOnlyHint: false, destructiveHint: true }],
      ["grokbot_room_create", { readOnlyHint: false, destructiveHint: false }],
      ["grokbot_skills_remove", { readOnlyHint: false, destructiveHint: true }],
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
        "force-protected": "00000000-0000-4000-8000-000000000000",
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
