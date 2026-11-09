/** Small helpers shared by the model block. Not exported from the package. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** A short, safe description of a value for an error message (never calls the value's own toString). */
export function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  return `a value of type ${typeof value}`;
}
