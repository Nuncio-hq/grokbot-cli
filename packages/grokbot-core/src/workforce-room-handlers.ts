import { randomUUID } from "node:crypto";
import { type Agent, resolveAgent } from "./agents.js";
import type {
  CommandHandlers,
  RunnerContext,
} from "./command-runner-context.js";
import { GrokBotError } from "./contracts.js";
import {
  agentFromReply,
  createWithClientId,
  namedLike,
} from "./workforce-handler-helpers.js";

type Room = Extract<Agent, { kind: "room" }>;

/** Resolves each member to one bot, keeping order and dropping repeats. */
function resolveMembers(
  queries: readonly string[],
  roster: readonly Agent[],
): readonly Agent[] {
  const members = new Map<string, Agent>();
  for (const query of queries) {
    const agent = resolveAgent(query, roster);
    if (agent.kind === "room") {
      throw new GrokBotError(
        "not-found",
        `${agent.name} is a room; room members must be bots.`,
      );
    }
    members.set(agent.agentId, agent);
  }
  return [...members.values()];
}

function asRoom(agent: Agent): Room {
  if (agent.kind === "room") return agent;
  throw new GrokBotError("not-found", `${agent.name} is a bot, not a room.`);
}

const sameMembers = (room: Room, members: readonly Agent[]) =>
  room.memberAgentIds.length === members.length &&
  members.every((m) => room.memberAgentIds.includes(m.agentId));

export function roomHandlers(
  ctx: RunnerContext,
): CommandHandlers<"room-create" | "room-members"> {
  return {
    "room-create": async (input, { signal }) => {
      const roster = await ctx.fetchAgents(signal);
      const members = resolveMembers(input.member, roster);
      const [same, ...more] = namedLike(roster, input.name);
      if (same) {
        if (
          more.length === 0 &&
          same.kind === "room" &&
          sameMembers(same, members)
        ) {
          return { room: same, members, result: "adopted" };
        }
        throw new GrokBotError(
          "ambiguous",
          `A room named "${same.name}" already exists (${same.agentId}) with other members. Change them with grokbot room-members, or pick another name.`,
        );
      }
      const room = await createWithClientId(
        ctx,
        "CreateGrokBotRoom",
        {
          agentId: randomUUID(),
          name: input.name.trim(),
          description: input.description?.trim() ?? "",
          memberAgentIds: members.map((m) => m.agentId),
          humanMemberUserIds: [],
        },
        "Run the same room-create again; it finds the room if it landed.",
        signal,
      );
      return { room: asRoom(room), members, result: "created" };
    },

    "room-members": async (input, { signal }) => {
      const roster = await ctx.fetchAgents(signal);
      const room = asRoom(resolveAgent(input.room, roster));
      const members = resolveMembers(input.member, roster);
      const reply = await ctx.server.call(
        "SetGrokBotRoomMembers",
        {
          agentId: room.agentId,
          memberAgentIds: members.map((m) => m.agentId),
        },
        { signal },
      );
      const updated = agentFromReply(reply);
      return { room: updated ? asRoom(updated) : room, members };
    },
  };
}
