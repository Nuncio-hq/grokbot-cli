import type { Agent } from "./agents.js";
import type { KeychainItem } from "./keychain-items.js";
import type { ProfileField } from "./workforce-profile.js";
import type { Routine } from "./workforce-routines.js";
import type { ListedSkill, Skill } from "./workforce-skills.js";

/** Phase 02 command results, one key per workforce command. */
export interface WorkforceOutputs {
  readonly hire: {
    readonly agent: Agent;
    /** The bot's own folder on the Cloud Box, named in its brief. */
    readonly folder: string;
    /** `adopted`: a bot with this name and brief already existed; it was briefed again. */
    readonly result: "created" | "adopted";
  };
  readonly update: {
    readonly agent: Agent;
    /** Empty when every field already had the requested value (nothing was written). */
    readonly changed: readonly ProfileField[];
  };
  readonly fire: { readonly agent: Agent };
  readonly "room-create": {
    readonly room: Agent;
    readonly members: readonly Agent[];
    readonly result: "created" | "adopted";
  };
  readonly "room-members": {
    readonly room: Agent;
    readonly members: readonly Agent[];
  };
  readonly "skills-list": {
    readonly agent: Agent;
    readonly skills: readonly ListedSkill[];
  };
  readonly "skills-push": {
    readonly agent: Agent;
    readonly skill: Skill;
    /**
     * `unchanged`: an imported skill with this name and content is already there.
     * `exists`: one with this name is there but its content was not listed to compare.
     * Neither writes anything. `replaced`: --replace deleted the old copy and imported this one.
     */
    readonly result: "imported" | "unchanged" | "exists" | "replaced";
  };
  readonly "skills-remove": {
    readonly agent: Agent;
    readonly skill: Skill;
    readonly remaining: number;
  };
  readonly "skills-run": { readonly agent: Agent; readonly skill: Skill };
  readonly "routines-list": {
    readonly agent: Agent;
    readonly routines: readonly Routine[];
  };
  readonly "routines-enable": {
    readonly agent: Agent;
    readonly routine: Routine;
  };
  readonly "routines-disable": {
    readonly agent: Agent;
    readonly routine: Routine;
  };
  readonly "routines-delete": {
    readonly agent: Agent;
    readonly routine: Routine;
    readonly remaining: number;
    /** True when a webhook key for it was in the Keychain and is now gone. */
    readonly webhookKeyRemoved: boolean;
  };
  readonly "routines-create": {
    readonly agent: Agent;
    readonly routine: Routine;
    readonly result: "created" | "exists";
    /** Set when the bot saved it in chat: the job of that message. */
    readonly jobId?: string;
  };
  readonly "routines-update": {
    readonly agent: Agent;
    readonly routine: Routine;
    /** Empty when every field already had the requested value (nothing was written). */
    readonly changed: readonly ("name" | "prompt" | "trigger")[];
    /** Set when the bot saved it in chat: the job of that message. */
    readonly jobId?: string;
  };
  readonly "routines-run": { readonly agent: Agent; readonly routine: Routine };
  readonly "routines-webhook-key": {
    readonly agent: Agent;
    readonly routine: Routine;
    /** Where senders POST, with `Authorization: Bearer <key>`. */
    readonly url: string;
    /** The item holding the key. The key itself is never in any output. */
    readonly keychainItem: KeychainItem;
    /** `exists`: a key was already stored and replace was not set; nothing was minted. */
    readonly result: "minted" | "replaced" | "exists";
  };
  readonly "routines-fire": {
    readonly agent: Agent;
    readonly routine: Routine;
    readonly url: string;
    /** HTTP status of the accepted POST. */
    readonly status: number;
    /** The response body: parsed JSON, else its text (at most 300 characters). */
    readonly reply: unknown;
  };
}
