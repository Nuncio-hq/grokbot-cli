import { describe, expect, it } from "vitest";
import { GROKBOT_BACKEND, GROKBOT_VERSION, listCommands } from "./index.js";

describe("grokbot-core public surface", () => {
  it("exports the backend, version, and Phase 01 command catalog", () => {
    expect(GROKBOT_BACKEND).toBe("https://api2.cursor.sh");
    expect(GROKBOT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      listCommands()
        .slice(0, 7)
        .map((c) => c.name),
    ).toEqual(["agents", "team", "ask", "send", "wait", "tail", "interrupt"]);
  });
});
