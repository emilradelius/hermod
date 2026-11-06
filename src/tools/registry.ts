/**
 * The tool registry: the set of tools one run may use, built from composable toolsets.
 *
 * - Every tool is checked when it is registered (name, description, zod schema, run function, capabilities), and
 *   its JSON Schema is built then, so a bad tool fails at start-up, not in the middle of a conversation.
 * - Duplicate tool names (also across toolsets) and duplicate toolset names are refused.
 * - A tool with the capability "messaging" is always refused: the model never gets a tool that sends a message
 *   (send_message is deliberately not model-callable). Delivery is application code, through a channel.
 * - A tool that says it is read-only must have only the capability "read".
 * - Order is by tool name, so `toApiTools()` is byte-for-byte stable and the prompt cache stays warm.
 * - `without(capabilities)` gives a new registry without the tools that have any of them (sub-agents, scheduled
 *   runs). The registry keeps frozen copies of the definitions: changing an object after registering it changes
 *   nothing here.
 */
import type { ToolCapability, ToolDef, ToolParam, Toolset } from "../types.js";
import { toolInputSchema } from "./define.js";

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOLSET_NAME_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

export const TOOL_CAPABILITIES: readonly ToolCapability[] = Object.freeze([
  "read",
  "memory.write",
  "skills.write",
  "internal.write",
  "external.write",
  "messaging",
  "scheduling",
  "delegation",
]);

interface Entry {
  tool: ToolDef;
  toolset: string;
  api: ToolParam;
}

export class ToolRegistry {
  readonly #entries: ReadonlyMap<string, Entry>;
  readonly #toolsetOrder: readonly string[];

  constructor(toolsets: readonly Toolset[] = []) {
    if (!Array.isArray(toolsets)) throw new TypeError("ToolRegistry: toolsets must be an array of { name, tools }.");
    const entries = new Map<string, Entry>();
    const order: string[] = [];
    for (const toolset of toolsets) {
      const setName = checkToolset(toolset);
      if (order.includes(setName)) throw new TypeError(`ToolRegistry: the toolset name "${setName}" is used twice.`);
      order.push(setName);
      for (const raw of toolset.tools) {
        const tool = checkTool(raw, setName);
        const existing = entries.get(tool.name);
        if (existing) {
          throw new TypeError(
            `ToolRegistry: the tool name "${tool.name}" is used twice (toolsets "${existing.toolset}" and "${setName}").`,
          );
        }
        entries.set(tool.name, { tool, toolset: setName, api: apiTool(tool) });
      }
    }
    const sorted = [...entries.keys()].sort(compareNames);
    this.#entries = new Map(sorted.map((name) => [name, entries.get(name) as Entry]));
    this.#toolsetOrder = Object.freeze(order);
  }

  /** The number of tools. */
  get size(): number {
    return this.#entries.size;
  }

  /** The tool with this exact name, or undefined. Own entries only ("constructor" or "__proto__" never match). */
  get(name: string): ToolDef | undefined {
    return typeof name === "string" ? this.#entries.get(name)?.tool : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** The name of the toolset a tool came from. */
  toolsetOf(name: string): string | undefined {
    return typeof name === "string" ? this.#entries.get(name)?.toolset : undefined;
  }

  /** All tools, ordered by name. */
  list(): ToolDef[] {
    return [...this.#entries.values()].map((entry) => entry.tool);
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  /** The tools grouped by toolset again (toolsets in registration order, tools by name; empty toolsets kept). */
  toolsets(): Toolset[] {
    return this.#toolsetOrder.map((name) => ({
      name,
      tools: this.list().filter((tool) => this.#entries.get(tool.name)?.toolset === name),
    }));
  }

  /** A new registry without every tool that has any of these capabilities. */
  without(capabilities: readonly ToolCapability[]): ToolRegistry {
    const drop = new Set<string>(capabilities);
    return this.#filter((tool) => !tool.capabilities.some((cap) => drop.has(cap)));
  }

  /** A new registry with only the tools of these toolsets (unknown names are an error). */
  only(toolsetNames: readonly string[]): ToolRegistry {
    for (const name of toolsetNames) {
      if (!this.#toolsetOrder.includes(name)) throw new TypeError(`ToolRegistry: there is no toolset "${String(name)}".`);
    }
    const keep = new Set(toolsetNames);
    return this.#filter((tool) => keep.has(this.#entries.get(tool.name)?.toolset ?? ""));
  }

  /** The tool definitions for the API, ordered by name. Fresh copies each call, identical every time. */
  toApiTools(): ToolParam[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry.api));
  }

  #filter(keep: (tool: ToolDef) => boolean): ToolRegistry {
    const sets = this.toolsets().map((set) => ({ name: set.name, tools: set.tools.filter(keep) }));
    return new ToolRegistry(sets);
  }
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkToolset(toolset: Toolset): string {
  if (toolset === null || typeof toolset !== "object") throw new TypeError("ToolRegistry: a toolset must be { name, tools }.");
  const { name, tools } = toolset;
  if (typeof name !== "string" || !TOOLSET_NAME_PATTERN.test(name)) {
    throw new TypeError(`ToolRegistry: a toolset name must match ${String(TOOLSET_NAME_PATTERN)} (got ${JSON.stringify(name)}).`);
  }
  if (!Array.isArray(tools)) throw new TypeError(`ToolRegistry: toolset "${name}" must have an array of tools.`);
  return name;
}

function checkTool(raw: ToolDef, toolset: string): ToolDef {
  if (raw === null || typeof raw !== "object") throw new TypeError(`ToolRegistry: toolset "${toolset}" has a tool that is not an object.`);
  const name: unknown = raw.name;
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `ToolRegistry: a tool name must be 1 to 64 letters, digits, "_" or "-" (got ${JSON.stringify(name)} in toolset "${toolset}").`,
    );
  }
  const where = `ToolRegistry: tool "${name}"`;
  if (typeof raw.description !== "string" || raw.description.trim() === "") {
    throw new TypeError(`${where} needs a description that says when to call it.`);
  }
  if (raw.input === null || typeof raw.input !== "object" || typeof (raw.input as { safeParse?: unknown }).safeParse !== "function") {
    throw new TypeError(`${where} needs a zod schema as its input.`);
  }
  if (typeof raw.run !== "function") throw new TypeError(`${where} needs a run function.`);
  if (typeof raw.readOnly !== "boolean") throw new TypeError(`${where} must say whether it is readOnly (true or false).`);
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length === 0) {
    throw new TypeError(`${where} must list its capabilities (for example ["read"]).`);
  }
  const capabilities: ToolCapability[] = [];
  for (const cap of raw.capabilities) {
    if (!TOOL_CAPABILITIES.includes(cap)) throw new TypeError(`${where} has an unknown capability ${JSON.stringify(cap)}.`);
    if (!capabilities.includes(cap)) capabilities.push(cap);
  }
  if (raw.readOnly && capabilities.some((cap) => cap !== "read")) {
    throw new TypeError(`${where} says it is read-only but has the capabilities ${JSON.stringify(capabilities)}.`);
  }
  if (capabilities.includes("messaging")) {
    throw new TypeError(
      `${where} can send messages ("messaging"). Hermod never gives the model a messaging tool; delivery is done by ` +
        "application code, through a channel.",
    );
  }
  for (const flag of ["untrustedOutput", "requiresApproval"] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw new TypeError(`${where}: ${flag} must be true or false.`);
  }
  const copy: ToolDef = {
    name,
    description: raw.description,
    input: raw.input,
    readOnly: raw.readOnly,
    capabilities: Object.freeze(capabilities) as ToolCapability[],
    run: raw.run,
  };
  if (raw.untrustedOutput !== undefined) copy.untrustedOutput = raw.untrustedOutput;
  if (raw.requiresApproval !== undefined) copy.requiresApproval = raw.requiresApproval;
  // Symbol-keyed extras (the delegate tool's settings) travel with the copy.
  for (const key of Object.getOwnPropertySymbols(raw)) {
    Object.defineProperty(copy, key, { value: (raw as unknown as Record<symbol, unknown>)[key], enumerable: false });
  }
  return Object.freeze(copy);
}

function apiTool(tool: ToolDef): ToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toolInputSchema(tool.input, tool.name),
    // Tool input streams as it is generated; the loop validates every input with the zod schema before running.
    eager_input_streaming: true,
  };
}
