import type { Agent, CommandOutputs, WorkforceCommandName } from "grokbot-core";
import { type HumanRenderers, plain, shortId, table } from "./render-parts.js";

type Routine = CommandOutputs["routines-list"]["routines"][number];

const who = (agent: Agent) => `${agent.name} (${shortId(agent.agentId)})`;
const names = (agents: readonly Agent[]) =>
  agents.map((a) => a.name).join(", ");
const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const nextRun = (r: Routine) =>
  r.enabled ? `Next run: ${r.nextRunAt ?? "not scheduled"}.` : "Paused.";
const routineLine = (verb: string, r: Routine, agent: Agent) =>
  `${verb} routine ${r.name} (${r.automationId}) for ${agent.name}. ${nextRun(r)}\n`;
const LIBRARY = "the Box-wide (all bots) skill library";
const skillTypes = (skills: CommandOutputs["skills-list"]["skills"]) => {
  const own = skills.filter((s) => s.managedBy !== "grokbot").length;
  return `${skills.length - own} grokbot-managed (built into GrokBot), ${own} user-managed (from this account's connectors and its own imports).\n`;
};
const pushed = (
  skill: CommandOutputs["skills-push"]["skill"],
): Record<CommandOutputs["skills-push"]["result"], string> => {
  const it = `${skill.name} (${skill.id})`;
  return {
    imported: `Imported skill ${it} into ${LIBRARY}.\n`,
    replaced: `Replaced skill ${it} in ${LIBRARY}.\n`,
    unchanged: `The Box-wide (all bots) skill library already has ${it} with this content; nothing imported.\n`,
    exists: `The Box-wide (all bots) skill library already has ${it}; its content could not be compared, so nothing was imported. Add --replace --yes to import this file over it.\n`,
  };
};

export const WORKFORCE_RENDERERS: HumanRenderers<WorkforceCommandName> = {
  hire: ({ agent, folder, result }) =>
    plain(
      result === "created"
        ? `Hired ${who(agent)} as ${agent.title}. Folder: ${folder}\n`
        : `${who(agent)} was already hired; briefed it again. Folder: ${folder}\n`,
    ),
  update: ({ agent, changed }) =>
    plain(
      changed.length === 0
        ? `${agent.name} already has those values; nothing changed.\n`
        : `Updated ${who(agent)}: ${changed.join(", ")}.\n`,
    ),
  fire: ({ agent }) => plain(`Fired ${who(agent)}.\n`),
  "room-create": ({ room, members, result }) =>
    plain(
      result === "created"
        ? `Created room ${who(room)} with ${names(members)}.\n`
        : `Room ${who(room)} already has ${names(members)}; nothing changed.\n`,
    ),
  "room-members": ({ room, members }) =>
    plain(`Room ${who(room)} now has ${names(members)}.\n`),
  "skills-list": ({ agent, skills }) =>
    plain(
      skills.length === 0
        ? `The Box-wide (all bots) skill library is empty (read through ${agent.name}).\n`
        : `Box-wide (all bots) skill library, read through ${agent.name}:\n${table(
            ["NAME", "TYPE", "SOURCE", "ID"],
            [
              ...skills.filter((s) => s.managedBy === "grokbot"),
              ...skills.filter((s) => s.managedBy !== "grokbot"),
            ].map((s) => [
              s.name || "-",
              `${s.managedBy}-managed`,
              s.source || "-",
              s.id,
            ]),
          )}${skillTypes(skills)}`,
    ),
  "skills-push": ({ skill, result }) => plain(pushed(skill)[result]),
  "skills-remove": ({ skill, remaining }) =>
    plain(
      `Removed skill ${skill.name} (${skill.id}) from ${LIBRARY}. ${count(remaining, "skill", "skills")} left.\n`,
    ),
  "skills-run": ({ agent, skill }) =>
    plain(
      `Started skill ${skill.name} (${skill.id}) from ${LIBRARY} on ${agent.name}.\n`,
    ),
  "routines-list": ({ agent, routines }) =>
    plain(
      routines.length === 0
        ? `${agent.name} has no routines.\n`
        : table(
            ["NAME", "ID", "STATE", "TRIGGER", "NEXT RUN"],
            routines.map((r) => [
              r.name || "-",
              r.automationId,
              r.enabled ? "on" : "off",
              r.schedule || r.trigger || "-",
              r.nextRunAt ?? "-",
            ]),
          ),
    ),
  "routines-enable": ({ agent, routine }) =>
    plain(routineLine("Turned on", routine, agent)),
  "routines-disable": ({ agent, routine }) =>
    plain(routineLine("Turned off", routine, agent)),
  "routines-delete": ({ agent, routine, remaining, webhookKeyRemoved }) =>
    plain(
      `Deleted routine ${routine.name} (${routine.automationId}) from ${agent.name}. ${count(remaining, "routine", "routines")} left.${webhookKeyRemoved ? " Removed its webhook key from the Keychain." : ""}\n`,
    ),
  "routines-create": ({ agent, routine, result }) =>
    plain(
      result === "created"
        ? routineLine("Created", routine, agent)
        : `${agent.name} already has routine ${routine.name} (${routine.automationId}); nothing created.\n`,
    ),
  "routines-update": ({ agent, routine, changed }) =>
    plain(
      changed.length === 0
        ? `Routine ${routine.name} (${routine.automationId}) already has those values; nothing changed.\n`
        : routineLine(`Changed ${changed.join(", ")} of`, routine, agent),
    ),
  "routines-run": ({ agent, routine }) =>
    plain(
      `Started routine ${routine.name} (${routine.automationId}) on ${agent.name}.\n`,
    ),
  "routines-webhook-key": ({ agent, routine, url, keychainItem, result }) =>
    plain(
      `${result === "exists" ? `A webhook key for routine ${routine.name} is already stored; nothing minted (--replace mints a new one). It is` : `${result === "minted" ? "Minted the webhook key" : "Minted an additional webhook key (earlier keys stay valid until the routine is deleted)"} for routine ${routine.name} and stored it`} in the Keychain (service ${keychainItem.service}); it is never printed.\nWebhook URL: ${url}\nFire it with: grokbot routines-fire ${JSON.stringify(agent.name)} ${JSON.stringify(routine.name)}\n`,
    ),
  "routines-fire": ({ agent, routine, status, reply }) =>
    plain(
      `Fired routine ${routine.name} (${routine.automationId}) on ${agent.name}: HTTP ${status}.${reply === null ? "" : ` Reply: ${typeof reply === "string" ? reply : JSON.stringify(reply)}`}\n`,
    ),
};
