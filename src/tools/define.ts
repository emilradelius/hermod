/**
 * Defining tools: `defineTool` (identity, for type inference of the input) and `toolInputSchema` (zod 4 → the JSON
 * Schema the API takes as `input_schema`).
 *
 * zod 4.6.7 facts (SDK facts sheet §2.4): `z.toJSONSchema` targets draft 2020-12 and adds a `$schema` key (dropped
 * here: the API does not need it), plain `z.object` gets `additionalProperties: false` in output mode, and
 * unrepresentable types (dates, functions, …) throw. The result is copied into a plain JSON object, so the
 * non-enumerable `~standard` property zod attaches never reaches the API and the schema serialises the same way
 * every time (the prompt cache depends on it).
 */
import { z } from "zod";
import type { ToolDef, ToolParam } from "../types.js";

/** Returns the definition unchanged; it exists so `run(input)` is typed from the zod schema. */
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

type InputSchema = ToolParam["input_schema"];

/**
 * The tool's input schema for the API. The top level must be an object (the API requires it). Every object node
 * that lists properties and does not say otherwise gets `additionalProperties: false`. Throws a TypeError with the
 * tool's name for a schema zod cannot represent or that is not an object.
 */
export function toolInputSchema(schema: z.ZodType, toolName = "(tool)"): InputSchema {
  let raw: unknown;
  try {
    raw = z.toJSONSchema(schema);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Tool "${toolName}": its input schema cannot be turned into JSON Schema (${why}).`, { cause: error });
  }
  const json = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") {
    throw new TypeError(
      `Tool "${toolName}": the input schema must be a z.object(...) (the API needs an object at the top level).`,
    );
  }
  closeObjects(json);
  return json as InputSchema;
}

/** Sets additionalProperties: false on every object schema with properties that leaves it unset. */
function closeObjects(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) closeObjects(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "object" && isPlainObject(record.properties) && record.additionalProperties === undefined) {
    record.additionalProperties = false;
  }
  for (const value of Object.values(record)) closeObjects(value);
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
