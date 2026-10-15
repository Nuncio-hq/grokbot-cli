import { describe, expect, it } from "vitest";
import type { AgentId } from "./agents.js";
import { GrokBotError } from "./contracts.js";
import {
  composeBrief,
  gatewayProfile,
  mergeProfile,
  parseBrief,
  staffFolder,
} from "./workforce-profile.js";

const ID = "5ca1ab1e-0000-4000-8000-000000000002" as AgentId;
const HIRED =
  "Writes the weekly report.\n\nInstructions:\nUse bullet points.\n\n" +
  "Workspace: your own folder is /workspace/staff/gb-phase2-probe/. Keep your files there; " +
  "put files other bots need in /workspace/shared/.";

describe("staffFolder", () => {
  it("slugs the bot's name, falling back to its id prefix", () => {
    expect([
      staffFolder("GB Phase2 Probe", ID),
      staffFolder("Nhân Viên Đức", ID),
      staffFolder("🤖", ID),
    ]).toEqual([
      "/workspace/staff/gb-phase2-probe/",
      "/workspace/staff/nhan-vien-duc/",
      "/workspace/staff/5ca1ab1e/",
    ]);
  });
});

describe("the brief in a bot's description", () => {
  it("is written with the folder rule last", () => {
    expect(
      composeBrief({
        summary: "Writes the weekly report. ",
        instructions: "Use bullet points.\n",
        folder: "/workspace/staff/gb-phase2-probe/",
      }),
    ).toBe(HIRED);
  });

  it("reads back into its parts, and a foreign description is all summary", () => {
    expect([parseBrief(HIRED), parseBrief("Test bot")]).toEqual([
      {
        summary: "Writes the weekly report.",
        instructions: "Use bullet points.",
        folder: "/workspace/staff/gb-phase2-probe/",
      },
      { summary: "Test bot", instructions: "", folder: undefined },
    ]);
  });
});

describe("mergeProfile", () => {
  const current = {
    name: "GB Phase2 Probe",
    title: "Probe",
    description: HIRED,
    avatarShape: "blob",
  };

  it("changes the title and keeps the brief byte for byte", () => {
    expect(mergeProfile(current, { title: "Probe (updated)" })).toEqual({
      profile: { ...current, title: "Probe (updated)" },
      changed: ["title"],
    });
  });

  it("swaps the instructions and keeps the summary and folder rule", () => {
    const { profile, changed } = mergeProfile(current, {
      instructions: "Use a table.",
    });
    expect([changed, profile.description]).toEqual([
      ["instructions"],
      HIRED.replace("Use bullet points.", "Use a table."),
    ]);
  });

  it("reports no change when every field already matches", () => {
    expect(
      mergeProfile(current, {
        title: "Probe",
        description: "Writes the weekly report.",
        instructions: "Use bullet points.",
      }).changed,
    ).toEqual([]);
  });
});

describe("gatewayProfile", () => {
  it("picks the bot from a list or an { agents } reply", () => {
    const row = { id: ID, name: "Probe", title: "T", description: "D" };
    const expected = { name: "Probe", title: "T", description: "D" };
    expect([
      gatewayProfile([{ id: "other" }, row], ID),
      gatewayProfile({ agents: [row] }, ID),
    ]).toEqual([expected, expected]);
  });

  it("fails when the gateway does not know the bot", () => {
    expect(() => gatewayProfile({ agents: [] }, ID)).toThrow(
      new GrokBotError(
        "not-found",
        `The Cloud Box gateway has no profile for ${ID}.`,
      ),
    );
  });
});
