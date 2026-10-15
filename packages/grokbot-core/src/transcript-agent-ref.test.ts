import { describe, expect, it } from "vitest";
import {
  assistantRow,
  delegateReplyRow,
  delegationRow,
  userRow,
} from "./fixtures/wire-entries.js";
import { parseTranscriptEntry } from "./transcript.js";

const STAFF_ID = "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5";

describe("parseTranscriptEntry on bot-to-bot agent refs", () => {
  it("reads toAgent {id, name, kind} and fromAgent {id, name} as {id, name}", () => {
    const staff = { id: STAFF_ID, name: "Staff Test" };
    const sent = delegationRow(111, "Reply PONG.", staff);
    const back = delegateReplyRow(113, "PONG", staff, { clientNonce: "n-2" });
    const sentEntry = parseTranscriptEntry(sent);
    const backEntry = parseTranscriptEntry(back);
    expect([
      sentEntry.kind === "assistant-message" && sentEntry.toAgent,
      backEntry.kind === "user-message" && [
        backEntry.fromAgent,
        backEntry.clientNonce,
      ],
    ]).toEqual([
      { id: STAFF_ID, name: "Staff Test" },
      [{ id: STAFF_ID, name: "Staff Test" }, "n-2"],
    ]);
  });

  it("reads a legacy bare name, falls back to the id for a nameless ref, and drops anything else", () => {
    const fromAgents = [
      "Test-Dev-1",
      { id: "d-1" },
      { id: "", name: "" },
      { kind: "agent" },
      ["Test-Dev-1"],
      42,
      "",
    ];
    expect(
      fromAgents.map((fromAgent, i) => {
        const e = parseTranscriptEntry(userRow(i, "hi", { fromAgent }));
        return e.kind === "user-message" ? e.fromAgent : "not a user message";
      }),
    ).toEqual([
      { id: undefined, name: "Test-Dev-1" },
      { id: "d-1", name: "d-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const legacy = parseTranscriptEntry(
      assistantRow(144, "Test ping", { toAgent: "Test-Dev-1" }),
    );
    expect(legacy.kind === "assistant-message" && legacy.toAgent).toEqual({
      id: undefined,
      name: "Test-Dev-1",
    });
  });
});
