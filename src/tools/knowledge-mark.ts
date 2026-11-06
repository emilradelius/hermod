/**
 * The mark of Hermod's own knowledge tools (the built-in `memory` and `skill_propose` tools, and the review's
 * `memory` and `skill_propose`). The approval policy lets a knowledge tool run in every mode but off only because
 * these tools write solely through MemoryService / ProposalService. Capabilities are self-declared, so the policy
 * does not trust them for that exemption: it asks for this mark, which only the built-in factories set.
 *
 * The mark is bound to the factory's own run function, not to the object: markKnowledgeTool puts `tool.run` into a
 * module-private WeakSet, and isBuiltInKnowledgeTool asks whether a tool's `run` is in that set. So:
 * - the registry's frozen copy keeps the exemption (it keeps the same run function);
 * - a tool whose run was replaced (on the factory's object or on a copy) loses it, because the exemption is for the
 *   code that writes only through the services, and that code is the run function;
 * - the mark cannot be forged: nothing outside this module can add to the set, and there is no property to copy or
 *   read (Object.getOwnPropertySymbols shows nothing). Reusing the factory's run function in another object only
 *   reuses the same service-bound code.
 * This module is not part of the public API.
 */
/** The run functions of the built-in knowledge tools (a function is an object, so it can be a WeakSet entry). */
const KNOWLEDGE_RUNS = new WeakSet<object>();

/** Marks a built-in knowledge tool (only Hermod's own factories call this). Returns the same object. */
export function markKnowledgeTool<T extends object>(tool: T): T {
  const run = (tool as { run?: unknown }).run;
  if (typeof run !== "function") throw new TypeError("markKnowledgeTool: the tool needs a run function.");
  KNOWLEDGE_RUNS.add(run);
  return tool;
}

/** True only for a tool whose run function is one a knowledge-tool factory made (also the registry's copy of one). */
export function isBuiltInKnowledgeTool(tool: unknown): boolean {
  if (tool === null || typeof tool !== "object") return false;
  try {
    const run = (tool as { run?: unknown }).run;
    return typeof run === "function" && KNOWLEDGE_RUNS.has(run);
  } catch {
    return false;
  }
}
