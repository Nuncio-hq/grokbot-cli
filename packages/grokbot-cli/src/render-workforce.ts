import {
  type Agent,
  type CommandOutputs,
  clipText,
  describeReviewChange,
  type WorkforceCommandName,
} from "grokbot-core";
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
const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;
/** `1536` -> `1.5 KB`; whole bytes below 1 KB. */
const size = (bytes: number) => {
  const unit = Math.min(
    Math.floor(Math.log2(Math.max(bytes, 1)) / 10),
    SIZE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** unit;
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
};
const filesNote = (team: CommandOutputs["files"]["team"]) =>
  `Team files: ${size(team.totalBytes)} used; you ${team.canEdit ? "can" : "cannot"} edit them.${team.complete ? "" : " The team listing is cut short; more files exist."}\n`;

type ReviewItem = CommandOutputs["review"]["items"][number];

const REVIEW_SUMMARY_LIMIT = 300;
const SUGGESTION_CELL = 60;
const person = (userId: string | null) =>
  userId === null ? "someone" : `user ${userId}`;
const at = (time: string | null) => time ?? "an unknown time";
/** One review item: id and status, who proposed it and when, the change in words. */
const reviewBlock = (item: ReviewItem) => {
  const [headline = "", ...more] = describeReviewChange(item.change);
  const reviewed = item.reviewedByUserId !== null || item.reviewedAt !== null;
  return `${[
    `${item.itemId}  ${item.status}`,
    `  Proposed by ${person(item.proposedByUserId)} on ${at(item.createdAt)}`,
    ...(reviewed
      ? [
          `  Reviewed by ${person(item.reviewedByUserId)} on ${at(item.reviewedAt)}`,
        ]
      : []),
    `  Change: ${headline}`,
    ...more.map((line) => `  ${line}`),
    ...(item.summary === ""
      ? []
      : [`  Summary: ${clipText(item.summary, REVIEW_SUMMARY_LIMIT)}`]),
    ...(item.method === "" ? [] : [`  Method: ${item.method}`]),
  ].join("\n")}\n`;
};

/** `12.5`; whole numbers without a decimal. */
const minutes = (n: number) => String(Math.round(n * 10) / 10);
const analyticsText = ({
  agent,
  weeklyActiveUsers,
  totalMinutesSaved,
  minutesSavedBeforeWindow,
  minutesSavedMeasured,
  days,
  topUsers,
}: CommandOutputs["analytics"]) => {
  const first = days[0];
  const head = [
    `Usage of ${who(agent)}:`,
    `Weekly active users: ${weeklyActiveUsers}`,
    `Minutes saved: ${minutesSavedMeasured ? minutes(totalMinutesSaved) : "not measured"}`,
    ...(first && minutesSavedBeforeWindow > 0
      ? [
          `Minutes saved before ${first.day}: ${minutes(minutesSavedBeforeWindow)}`,
        ]
      : []),
  ].join("\n");
  if (
    totalMinutesSaved === 0 &&
    topUsers.length === 0 &&
    days.every((d) => d.userTurns === 0)
  ) {
    return `${head}\nNo usage recorded yet.\n`;
  }
  return `${head}\n${
    days.length === 0
      ? ""
      : `\n${table(
          ["DAY", "ACTIVE", "7-DAY ACTIVE", "MESSAGES", "MINUTES SAVED"],
          days.map((d) => [
            d.day || "-",
            String(d.activeUsers),
            String(d.trailingSevenDayActiveUsers),
            String(d.userTurns),
            minutes(d.minutesSaved),
          ]),
        )}`
  }${
    topUsers.length === 0
      ? ""
      : `\nTop users:\n${table(
          ["USER", "MESSAGES", "MINUTES SAVED"],
          topUsers.map((u) => [
            `${u.displayName || `user ${u.userId}`}${u.isExternal ? " (external)" : ""}`,
            String(u.userTurns),
            minutes(u.minutesSaved),
          ]),
        )}`
  }`;
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
  files: ({ agent, files, team }) =>
    plain(
      files.length === 0
        ? `${agent.name} has no files.\n`
        : `Files of ${agent.name}:\n${table(
            ["SECTION", "NAME", "PATH", "SIZE", "UPDATED"],
            files.map((f) => [
              f.section,
              f.name,
              f.path,
              size(f.sizeBytes),
              f.updatedAt ?? "-",
            ]),
          )}${filesNote(team)}`,
    ),
  "files-remove": ({ agent, file }) =>
    plain(
      `Removed ${file.section} file ${file.path} from ${agent.name}; it can no longer read it.\n`,
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
  "routines-webhook-key": ({ agent, routine, url, keychainItem, result }) =>
    plain(
      `${result === "exists" ? `A webhook key for routine ${routine.name} is already stored; nothing minted (--replace mints a new one). It is` : `${result === "minted" ? "Minted the webhook key" : "Minted an additional webhook key (earlier keys stay valid until the routine is deleted)"} for routine ${routine.name} and stored it`} in the Keychain (service ${keychainItem.service}); it is never printed.\nWebhook URL: ${url}\nFire it with: grokbot routines-fire ${JSON.stringify(agent.name)} ${JSON.stringify(routine.name)}\n`,
    ),
  "routines-fire": ({ agent, routine, status, reply }) =>
    plain(
      `Fired routine ${routine.name} (${routine.automationId}) on ${agent.name}: HTTP ${status}.${reply === null ? "" : ` Reply: ${typeof reply === "string" ? reply : JSON.stringify(reply)}`}\n`,
    ),
  review: ({ agent, status, limit, items }) => {
    const kind = status === "all" ? "" : `${status} `;
    return plain(
      items.length === 0
        ? `${agent.name} has no ${kind}review items.\n`
        : `${count(items.length, `${kind}review item`, `${kind}review items`)} for ${who(agent)}:\n\n${items.map(reviewBlock).join("\n")}${items.length >= limit ? `\nThe list stops at ${count(limit, "item", "items")}; raise --limit to see more.\n` : ""}`,
    );
  },
  "review-resolve": ({ agent, decision, itemId, item }) =>
    plain(
      `${decision === "approve" ? "Approved" : "Rejected"} review item ${itemId} of ${agent.name}.\n${item === null ? "" : `\n${reviewBlock(item)}`}`,
    ),
  analytics: (analytics) => plain(analyticsText(analytics)),
  suggestions: ({ agent, suggestions }) =>
    plain(
      suggestions.length === 0
        ? `${agent.name} has no suggestions.\n`
        : `Suggestions for ${who(agent)}:\n${table(
            ["ID", "TITLE", "DETAIL", "PROMPT"],
            suggestions.map((s) => [
              s.id,
              s.title || "-",
              clipText(s.detail, SUGGESTION_CELL) || "-",
              clipText(s.prompt, SUGGESTION_CELL) || "-",
            ]),
          )}Close some with: grokbot suggestions-dismiss --suggestion <id>\n`,
    ),
  "suggestions-dismiss": ({ agent, reason, dismissed }) =>
    plain(
      `Closed ${count(dismissed.length, "suggestion", "suggestions")} of ${agent.name} (${reason}): ${dismissed.map((s) => s.title || s.id).join(", ")}.\n`,
    ),
};
