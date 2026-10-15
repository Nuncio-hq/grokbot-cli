import type { Agent, CommandOutputs, WorkforceCommandName } from "grokbot-core";
import {
  type McpOverrides,
  plural,
  type ToolSummaries,
} from "./mcp-tool-parts.js";

type Routine = CommandOutputs["routines-list"]["routines"][number];

/** Overrides on protected bots and managed skills, and local file paths, are CLI only. */
const FORCE = "force-protected";
const MANAGED = "include-managed";

export const WORKFORCE_OVERRIDES: McpOverrides<WorkforceCommandName> = {
  hire: {
    note: "Idempotent: calling it again with the same name re-briefs the bot it hired and keeps its instructions unless you pass new ones",
    hiddenParams: ["instructions-file"],
  },
  update: { hiddenParams: ["instructions-file"] },
  fire: { hiddenParams: [FORCE] },
  "skills-list": {
    note: "The skill library is Box-wide: every bot sees the same one",
  },
  "skills-push": {
    note: "Pass the SKILL.md text as markdown. The library is Box-wide (all bots). Same name and content: no-op; different content needs replace and yes, which deletes the old copy for every bot",
    hiddenParams: ["file"],
    destructive: true,
  },
  "skills-remove": {
    note: "Removes an imported skill for every bot (the library is Box-wide)",
    hiddenParams: [MANAGED, FORCE],
  },
  "skills-run": { hiddenParams: [MANAGED] },
  "routines-enable": { hiddenParams: [FORCE] },
  "routines-disable": { hiddenParams: [FORCE] },
  "routines-delete": { hiddenParams: [FORCE] },
};

const PUSHED: Readonly<
  Record<CommandOutputs["skills-push"]["result"], string>
> = {
  imported: "Imported skill",
  replaced: "Replaced skill",
  unchanged: "Nothing imported: it already has the same content as skill",
  exists:
    "Nothing imported: its content could not be compared with the existing skill",
};

const names = (agents: readonly Agent[]) =>
  agents.map((a) => a.name).join(", ");
const routineText = (r: Routine) =>
  `${r.name} (${r.automationId}): ${r.enabled ? "on" : "off"}, ${r.schedule || r.trigger || "no trigger"}${r.nextRunAt ? `, next run ${r.nextRunAt}` : ""}`;

export const WORKFORCE_SUMMARIES: ToolSummaries<WorkforceCommandName> = {
  hire: ({ agent, folder, result }) =>
    `${result === "created" ? "Hired" : "Re-briefed the already hired"} ${agent.name} (${agent.agentId}). Folder: ${folder}`,
  update: ({ agent, changed }) =>
    changed.length === 0
      ? `${agent.name} already had those values; nothing changed.`
      : `Updated ${agent.name}: ${changed.join(", ")}.`,
  fire: ({ agent }) => `Deleted ${agent.name} (${agent.agentId}).`,
  "room-create": ({ room, members, result }) =>
    `${result === "created" ? "Created" : "Found existing"} room ${room.name} (${room.agentId}) with ${names(members)}. Send it a message with the ask tool.`,
  "room-members": ({ room, members }) =>
    `Room ${room.name} now has ${names(members)}.`,
  "skills-list": ({ agent, skills }) =>
    [
      `The Box-wide (all bots) skill library has ${plural(skills.length, "skill", "skills")} (read through ${agent.name}):`,
      ...skills.map((s) => `- ${s.name || s.id} (${s.source}, ${s.id})`),
    ].join("\n"),
  "skills-push": ({ agent, skill, result }) =>
    result === "exists"
      ? `${PUSHED[result]} ${skill.name} (${skill.id}) in the Box-wide (all bots) skill library. Pass replace and yes to import over it.`
      : `${PUSHED[result]} ${skill.name} (${skill.id}) ${result === "imported" ? "into" : "in"} the Box-wide (all bots) skill library, through ${agent.name}.`,
  "skills-remove": ({ agent, skill, remaining }) =>
    `Removed skill ${skill.name} (${skill.id}) from the Box-wide (all bots) skill library, through ${agent.name}; ${plural(remaining, "skill", "skills")} left.`,
  "skills-run": ({ agent, skill }) =>
    `Started skill ${skill.name} (${skill.id}) from the Box-wide (all bots) skill library on ${agent.name}.`,
  "routines-list": ({ agent, routines }) =>
    [
      `${agent.name} has ${plural(routines.length, "routine", "routines")}:`,
      ...routines.map((r) => `- ${routineText(r)}`),
    ].join("\n"),
  "routines-enable": ({ agent, routine }) =>
    `Turned on ${agent.name}'s routine ${routineText(routine)}.`,
  "routines-disable": ({ agent, routine }) =>
    `Turned off ${agent.name}'s routine ${routineText(routine)}.`,
  "routines-delete": ({ agent, routine, remaining }) =>
    `Deleted ${agent.name}'s routine ${routine.name} (${routine.automationId}); ${plural(remaining, "routine", "routines")} left.`,
  "routines-create": ({ agent, routine, result }) =>
    `${result === "created" ? "Created" : "Found existing"} routine for ${agent.name}: ${routineText(routine)}.`,
};
