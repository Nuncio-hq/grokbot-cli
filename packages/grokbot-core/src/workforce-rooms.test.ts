import { describe, expect, it } from "vitest";
import { GrokBotError, type JsonObject } from "./contracts.js";
import {
  BASE_ROSTER,
  bodyOf,
  methods,
  PRIMARY,
  PROBE,
  PROBE_BOT,
  ROOM,
  STAFF,
  wireRoom,
  workforceRunner,
} from "./fixtures/workforce-fakes.js";

const ROSTER = { agents: [...BASE_ROSTER, PROBE_BOT] };
const CREATE = {
  name: "GB Phase2 Room",
  member: ["GB Phase2 Probe", "staff test"],
  json: false,
};
const failure = (e: unknown) =>
  e instanceof GrokBotError ? [e.code, e.message] : e;

describe("room-create", () => {
  it("creates a room of the named bots with a client-made id", async () => {
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: [ROSTER],
      CreateGrokBotRoom: (body: JsonObject) => ({
        agent: wireRoom(
          String(body.agentId),
          String(body.name),
          body.memberAgentIds as unknown[],
        ),
      }),
    });
    const out = await runner.run("room-create", CREATE);
    expect([
      out.result,
      out.room.kind,
      out.room.name,
      out.members.map((m) => m.name),
    ]).toEqual([
      "created",
      "room",
      "GB Phase2 Room",
      ["GB Phase2 Probe", "Staff Test"],
    ]);
    expect(bodyOf(log, "CreateGrokBotRoom")).toEqual({
      agentId: out.room.agentId,
      name: "GB Phase2 Room",
      description: "",
      memberAgentIds: [PROBE, STAFF],
      humanMemberUserIds: [],
    });
  });

  it("run again, adopts the room with the same members and sends nothing", async () => {
    const room = wireRoom(ROOM, "GB Phase2 Room", [STAFF, PROBE]);
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: [{ agents: [...ROSTER.agents, room] }],
    });
    const out = await runner.run("room-create", CREATE);
    expect([out.result, out.room.agentId, methods(log)]).toEqual([
      "adopted",
      ROOM,
      ["server:ListGrokBotAgents"],
    ]);
  });

  it("refuses a taken name when the members differ", async () => {
    const room = wireRoom(ROOM, "GB Phase2 Room", [PRIMARY]);
    const { runner } = workforceRunner({
      ListGrokBotAgents: [{ agents: [...ROSTER.agents, room] }],
    });
    expect(await runner.run("room-create", CREATE).catch(failure)).toEqual([
      "ambiguous",
      `A room named "GB Phase2 Room" already exists (${ROOM}) with other members. Change them with grokbot room-members, or pick another name.`,
    ]);
  });

  it("refuses a room as a member", async () => {
    const room = wireRoom(ROOM, "Old Room", [PRIMARY]);
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: [{ agents: [...ROSTER.agents, room] }],
    });
    const error = await runner
      .run("room-create", { ...CREATE, member: ["Old Room"] })
      .catch(failure);
    expect([error, methods(log)]).toEqual([
      ["not-found", "Old Room is a room; room members must be bots."],
      ["server:ListGrokBotAgents"],
    ]);
  });
});

describe("room-members", () => {
  it("sets the members of a room and returns the updated room", async () => {
    const room = wireRoom(ROOM, "GB Phase2 Room", [PROBE, STAFF]);
    const { runner, log } = workforceRunner({
      ListGrokBotAgents: [{ agents: [...ROSTER.agents, room] }],
      SetGrokBotRoomMembers: [
        { agent: wireRoom(ROOM, "GB Phase2 Room", [PRIMARY]) },
      ],
    });
    const out = await runner.run("room-members", {
      room: "GB Phase2 Room",
      member: ["Primary Test"],
      json: false,
    });
    expect(
      out.room.kind === "room" && [out.room.memberAgentIds, out.members.length],
    ).toEqual([[PRIMARY], 1]);
    expect(bodyOf(log, "SetGrokBotRoomMembers")).toEqual({
      agentId: ROOM,
      memberAgentIds: [PRIMARY],
    });
  });

  it("refuses a bot where a room is expected", async () => {
    const { runner } = workforceRunner({ ListGrokBotAgents: [ROSTER] });
    const error = await runner
      .run("room-members", {
        room: "Staff Test",
        member: ["Primary Test"],
        json: false,
      })
      .catch(failure);
    expect(error).toEqual(["not-found", "Staff Test is a bot, not a room."]);
  });
});
