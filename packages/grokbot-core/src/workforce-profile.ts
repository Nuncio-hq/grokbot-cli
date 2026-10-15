import { type AgentId, slugify } from "./agents.js";
import { GrokBotError, type JsonObject } from "./contracts.js";
import { asJsonObject, readString } from "./transcript.js";

/**
 * A bot's brief, stored in its one `description` field: what it does, optional
 * instructions, and the folder rule `hire` adds. Bots made elsewhere have a summary only.
 */
export interface Brief {
  readonly summary: string;
  readonly instructions: string;
  readonly folder: string | undefined;
}

/**
 * What gateway `updateAgent` takes as `profile`. The app's schema requires `name` and
 * `description`; the rest are optional, so they are sent only when the bot has them.
 */
export interface Profile {
  readonly name: string;
  readonly description: string;
  readonly title?: string;
  readonly avatarShape?: string;
  readonly avatarColor?: string;
}

export type ProfileField = "title" | "description" | "instructions";

export interface ProfileChange {
  readonly title?: string;
  readonly description?: string;
  readonly instructions?: string;
}

export const SHARED_FOLDER = "/workspace/shared/";
const INSTRUCTIONS_HEADING = "\n\nInstructions:\n";
const WORKSPACE_RULE =
  /\n\nWorkspace: your own folder is (\S+)\. Keep your files there; put files other bots need in \/workspace\/shared\/\.$/;

/**
 * `/workspace/staff/<name slug>/`, or the agentId prefix when the name has no letters or
 * digits. When a bot on `roster` already owns that folder, the prefix is appended.
 */
export function staffFolder(
  name: string,
  agentId: AgentId,
  roster: readonly { readonly description: string }[] = [],
): string {
  const prefix = agentId.slice(0, 8);
  const slug = slugify(name);
  const folder = `/workspace/staff/${slug || prefix}/`;
  const taken = roster.some((a) => parseBrief(a.description).folder === folder);
  return taken && slug ? `/workspace/staff/${slug}-${prefix}/` : folder;
}

export function composeBrief({ summary, instructions, folder }: Brief): string {
  const parts = [summary.trim()];
  if (instructions.trim())
    parts.push(INSTRUCTIONS_HEADING, instructions.trim());
  if (folder) {
    parts.push(
      `\n\nWorkspace: your own folder is ${folder}. Keep your files there; put files other bots need in ${SHARED_FOLDER}.`,
    );
  }
  return parts.join("");
}

export function parseBrief(description: string): Brief {
  const rule = WORKSPACE_RULE.exec(description);
  const body = rule ? description.slice(0, rule.index) : description;
  const cut = body.indexOf(INSTRUCTIONS_HEADING);
  return {
    summary: (cut < 0 ? body : body.slice(0, cut)).trim(),
    instructions: cut < 0 ? "" : body.slice(cut + INSTRUCTIONS_HEADING.length),
    folder: rule?.[1],
  };
}

/** The profile after `change`, and which parts of it differ from `current`. */
export function mergeProfile(
  current: Profile,
  change: ProfileChange,
): { readonly profile: Profile; readonly changed: readonly ProfileField[] } {
  const brief = parseBrief(current.description);
  const next: Brief = {
    summary: change.description?.trim() ?? brief.summary,
    instructions: change.instructions?.trim() ?? brief.instructions.trim(),
    folder: brief.folder,
  };
  const title = change.title?.trim() ?? current.title;
  const changed: ProfileField[] = [];
  if (title !== current.title) changed.push("title");
  if (next.summary !== brief.summary) changed.push("description");
  if (next.instructions !== brief.instructions.trim()) {
    changed.push("instructions");
  }
  const briefChanged = changed.some((field) => field !== "title");
  const description = briefChanged ? composeBrief(next) : current.description;
  return {
    profile: {
      ...current,
      description,
      ...(title !== undefined && { title }),
    },
    changed,
  };
}

/** Finds one bot's profile in a gateway `listAgents` reply (a list or `{ agents }`). */
export function gatewayProfile(raw: unknown, agentId: AgentId): Profile {
  const o = asJsonObject(raw);
  const rows = Array.isArray(raw) ? raw : o?.agents;
  if (!Array.isArray(rows)) {
    throw new GrokBotError("protocol", "listAgents: no agents list");
  }
  const row = rows
    .map(asJsonObject)
    .find((r): r is JsonObject => r?.id === agentId || r?.agentId === agentId);
  if (!row) {
    throw new GrokBotError(
      "not-found",
      `The Cloud Box gateway has no profile for ${agentId}.`,
    );
  }
  const name = readString(row, "name");
  if (!name) {
    throw new GrokBotError(
      "protocol",
      `listAgents: the profile of ${agentId} has no name`,
    );
  }
  const optional = Object.fromEntries(
    (["title", "avatarShape", "avatarColor"] as const).flatMap((key) => {
      const value = readString(row, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return {
    name,
    description: readString(row, "description") ?? "",
    ...optional,
  };
}
