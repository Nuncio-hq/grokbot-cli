import { describe, expect, it } from "vitest";
import { mcpClientName, noteMcpClient } from "./mcp-client-name.js";

describe("noteMcpClient", () => {
  it("keeps the name from initialize, then from a stateless request's _meta", () => {
    noteMcpClient({
      protocolVersion: "2025-06-18",
      clientInfo: { name: "claude-code", version: "2.1.299" },
    });
    expect(mcpClientName()).toBe("claude-code");
    noteMcpClient({
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: " Cursor " },
      },
    });
    expect(mcpClientName()).toBe("Cursor");
  });

  it("ignores requests that carry no client name", () => {
    noteMcpClient({ clientInfo: { name: "codex" } });
    noteMcpClient({ name: "grokbot_agents", arguments: {} });
    noteMcpClient({ clientInfo: { name: "  " } });
    expect(mcpClientName()).toBe("codex");
  });
});
