/**
 * What the loop's runAgent takes as `deps.knowledge`: the frozen memory snapshot, the skills index, and the full
 * bodies of skills attached to a run (scheduled jobs). All three are read once, at session start.
 */
import type { Id } from "../types.js";
import { renderSkillsIndex, type SkillService } from "../skills/skills.js";
import type { MemoryService } from "./memory.js";

export interface KnowledgeDeps {
  /** renderMemorySnapshot over the named stores ("" when they are all empty). */
  snapshot(agentId: Id, stores: string[]): Promise<string>;
  /** renderSkillsIndex over the agent's active and stale skills ("" when there are none). */
  skillsIndex(agentId: Id): Promise<string>;
  /** Each named skill's full body under a heading; unknown or archived names get a short note instead. */
  attachSkillBodies(agentId: Id, names: string[]): Promise<string>;
}

export function knowledgeDeps(deps: { memory: MemoryService; skills: SkillService }): KnowledgeDeps {
  return {
    snapshot: (agentId, stores) => deps.memory.snapshot(agentId, stores),
    async skillsIndex(agentId) {
      return renderSkillsIndex(await deps.skills.list(agentId));
    },
    async attachSkillBodies(agentId, names) {
      const sections: string[] = [];
      for (const name of [...new Set(names)]) {
        if (typeof name !== "string" || name.trim() === "") continue;
        const skill = await deps.skills.use(agentId, name);
        if (!skill) {
          sections.push(`## Skill: ${name.replace(/\s+/gu, " ").slice(0, 64)}\n(Not attached: there is no active skill with this name.)`);
          continue;
        }
        sections.push(`## Skill: ${skill.name}\n${skill.description}\n\n${skill.body.trim()}`);
      }
      return sections.join("\n\n");
    },
  };
}
