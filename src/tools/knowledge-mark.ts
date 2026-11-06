/**
 * The mark of Hermod's own knowledge tools (the built-in `memory` and `skill_propose` tools, and the review's
 * `memory` and `skill_propose`). The approval policy lets a knowledge tool run in every mode but off only because
 * these tools write solely through MemoryService / ProposalService. Capabilities are self-declared, so the policy
 * does not trust them for that exemption: it asks for this mark, which only the built-in factories set.
 *
 * The mark is a module-private, non-enumerable symbol (not Symbol.for, so it cannot be recreated), and this module
 * is not part of the public API. Spreading a marked tool (`{ ...tool }`) does not copy it, so a changed copy falls
 * back to the ordinary side-effect rules. The tool registry keeps it on its frozen copies (it copies symbol keys).
 */
const KNOWLEDGE_TOOL: unique symbol = Symbol("hermod.knowledge-tool");

/** Marks a built-in knowledge tool (only Hermod's own factories call this). Returns the same object. */
export function markKnowledgeTool<T extends object>(tool: T): T {
  Object.defineProperty(tool, KNOWLEDGE_TOOL, { value: true, enumerable: false, writable: false, configurable: false });
  return tool;
}

/** True only for a tool one of Hermod's knowledge-tool factories made (or the registry's copy of one). */
export function isBuiltInKnowledgeTool(tool: unknown): boolean {
  if (tool === null || typeof tool !== "object") return false;
  try {
    return Object.prototype.hasOwnProperty.call(tool, KNOWLEDGE_TOOL) && (tool as Record<symbol, unknown>)[KNOWLEDGE_TOOL] === true;
  } catch {
    return false;
  }
}
