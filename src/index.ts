/**
 * Hermod's runtime: the public API.
 *
 * One entry point for every block (the shared types, storage adapters, safety, the model client, tools, the agent
 * loop, memory, skills, proposals, learning, modes, the scheduler and the delivery channels). The scripted fake model
 * and its message builders are a separate entry point, "hermod/testing", so production code never pulls them in.
 *
 * The rule the whole API is built around: the agent only proposes. Memory, skill and side-effect changes become
 * proposals a person approves, unless a memory store's owner allows add-only writes.
 */
export const VERSION = "0.1.0";

// The shared contract (types, MEMORY_SEPARATOR, AgentOffError).
export * from "./types.js";

export * from "./storage/index.js";
export * from "./safety/index.js";
export * from "./model/index.js";
export * from "./tools/index.js";
export * from "./tools/builtin/index.js";
export * from "./loop/index.js";
export * from "./memory/index.js";
export * from "./skills/index.js";
export * from "./proposals/index.js";
export * from "./learning/index.js";
export * from "./modes/index.js";
export * from "./scheduler/index.js";
export * from "./channels/index.js";

// The loop and the memory block both name a DEFAULT_MEMORY_STORES. An explicit export wins over the two star
// exports: the memory block's (store specs with caps) is the public one, and the loop's list of the store names
// loaded into the snapshot is exported under its own name.
export { DEFAULT_MEMORY_STORES } from "./memory/index.js";
export { DEFAULT_MEMORY_STORES as DEFAULT_SNAPSHOT_STORES } from "./loop/index.js";
