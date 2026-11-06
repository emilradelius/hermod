/**
 * Built-in knowledge tools: memory, skill_list, skill_view, skill_propose, session_search. None of them can send a
 * message, schedule a job or run a sub-agent; the writing ones (memory, skill_propose) go through the proposal rules.
 */
import type { MemoryService } from "../../memory/memory.js";
import type { ProposalService } from "../../proposals/proposals.js";
import type { SkillService } from "../../skills/skills.js";
import type { Storage, Toolset } from "../../types.js";
import { makeMemoryTool } from "./memory-tool.js";
import { makeSessionSearchTool } from "./session-search.js";
import { makeSkillTools } from "./skill-tools.js";

export { FROZEN_NOTE, MEMORY_TOOL_DESCRIPTION, makeMemoryTool, memoryOpSchema, memoryToolInput } from "./memory-tool.js";
export {
  MAX_MESSAGE_CHARS,
  MAX_RESULT_CHARS,
  MAX_SEARCH_LIMIT,
  formatSearchResult,
  makeSessionSearchTool,
  sessionSearchInput,
} from "./session-search.js";
export {
  WAITING_NOTE,
  makeSkillTools,
  skillChangeSchema,
  skillListInput,
  skillProposeInput,
  skillViewInput,
} from "./skill-tools.js";

export const KNOWLEDGE_TOOLSET = "knowledge";

export interface KnowledgeToolsetDeps {
  memory: MemoryService;
  skills: SkillService;
  proposals: ProposalService;
  storage: Storage;
}

/** The "knowledge" toolset: memory, skill_list, skill_view, skill_propose and session_search. */
export function knowledgeToolset(deps: KnowledgeToolsetDeps): Toolset {
  return {
    name: KNOWLEDGE_TOOLSET,
    tools: [makeMemoryTool(deps.memory), ...makeSkillTools(deps.skills, deps.proposals), makeSessionSearchTool(deps.storage)],
  };
}
