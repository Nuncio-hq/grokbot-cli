import type { Agent } from "./agents.js";
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
  };
  readonly "routines-create": {
    readonly agent: Agent;
    readonly routine: Routine;
    readonly result: "created" | "exists";
  };
}
