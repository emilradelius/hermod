/**
 * Where a session's frozen knowledge comes from: the memory snapshot, the skills index and, for scheduled jobs, the
 * full bodies of attached skills. runAgent asks for them ONCE, when a session starts, and stores them on the session
 * row; a continued session reuses the stored text and never asks again.
 *
 * Apps pass the knowledge services (MemoryService / skills) as `deps.knowledge`. `storageKnowledge` is a plain
 * fallback that reads the stores and skills straight from storage, for apps and tests without those services.
 */
import type { Id, Storage } from "../types.js";

export interface KnowledgeSource {
  /** The memory snapshot for these stores, frozen at session start. */
  snapshot(agentId: Id, stores: string[]): Promise<string>;
  /** The skills index ("name: one-liner" lines). */
  skillsIndex(agentId: Id): Promise<string>;
  /** The full bodies of these skills, for the system prompt (scheduled jobs). */
  attachSkillBodies?(agentId: Id, names: string[]): Promise<string>;
}

const INDEX_LINE_CHARS = 60;

/** A KnowledgeSource that reads storage directly (no caps, no injection scan: those belong to the write path). */
export function storageKnowledge(storage: Storage): KnowledgeSource {
  return {
    async snapshot(agentId, stores) {
      const parts: string[] = [];
      for (const name of stores) {
        const store = await storage.memory.getStore(agentId, name);
        if (store && store.content.trim() !== "") parts.push(`## ${name}\n${store.content}`);
      }
      return parts.join("\n\n");
    },
    async skillsIndex(agentId) {
      const skills = await storage.skills.list(agentId, { status: "active" });
      return skills.map((skill) => `${skill.name}: ${oneLiner(skill.description)}`).join("\n");
    },
    async attachSkillBodies(agentId, names) {
      const parts: string[] = [];
      for (const name of names) {
        const skill = await storage.skills.get(agentId, name);
        parts.push(skill && skill.status !== "archived" ? `## Skill: ${name}\n${skill.body}` : `## Skill: ${name}\n(not found)`);
      }
      return parts.join("\n\n");
    },
  };
}

function oneLiner(description: string): string {
  const first = description.split(/(?<=[.!?])\s/)[0] ?? description;
  const line = first.replace(/\s+/g, " ").trim();
  return line.length <= INDEX_LINE_CHARS ? line : `${line.slice(0, INDEX_LINE_CHARS - 1)}…`;
}
