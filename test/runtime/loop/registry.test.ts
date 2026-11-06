import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toolInputSchema, ToolRegistry } from "../../../src/tools/index.js";
import type { ToolCapability, ToolDef } from "../../../src/types.js";

function tool(name: string, capabilities: ToolCapability[] = ["read"], extra: Partial<ToolDef> = {}): ToolDef {
  return {
    name,
    description: `Tool ${name}. Use it in tests.`,
    input: z.object({ q: z.string() }),
    readOnly: capabilities.every((c) => c === "read"),
    capabilities,
    run: () => "ok",
    ...extra,
  };
}

describe("toolInputSchema", () => {
  it("drops $schema and closes every object with properties", () => {
    const schema = toolInputSchema(
      z.object({ a: z.string().describe("first"), nested: z.object({ b: z.number() }), map: z.record(z.string(), z.number()) }),
    );
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.nested?.additionalProperties).toBe(false);
    expect(props.map?.additionalProperties).toEqual({ type: "number" });
    expect(props.a?.description).toBe("first");
    // A plain JSON object: serialises the same way every time.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it("refuses a non-object top level and unrepresentable types, naming the tool", () => {
    expect(() => toolInputSchema(z.string(), "bad_tool")).toThrow(/bad_tool.*z\.object/);
    expect(() => toolInputSchema(z.object({ when: z.date() }), "dated")).toThrow(/dated/);
  });

  it("defineTool returns the same object", () => {
    const def = tool("x");
    expect(defineTool(def)).toBe(def);
  });
});

describe("ToolRegistry", () => {
  it("orders tools by name and gives byte-identical API tools every time", () => {
    const registry = new ToolRegistry([
      { name: "b", tools: [tool("zeta"), tool("alpha")] },
      { name: "a", tools: [tool("Mid"), tool("beta")] },
    ]);
    expect(registry.names()).toEqual(["Mid", "alpha", "beta", "zeta"]);
    const first = JSON.stringify(registry.toApiTools());
    const second = JSON.stringify(registry.toApiTools());
    expect(first).toBe(second);
    const api = registry.toApiTools();
    expect(api[0]).toMatchObject({ name: "Mid", eager_input_streaming: true, input_schema: { type: "object" } });
    // Fresh copies: changing one does not change the registry.
    (api[0] as { name: string }).name = "hacked";
    expect(registry.toApiTools()[0]?.name).toBe("Mid");
  });

  it("rejects duplicate tool names, also across toolsets, and duplicate toolset names", () => {
    expect(() => new ToolRegistry([{ name: "a", tools: [tool("x"), tool("x")] }])).toThrow(/used twice/);
    expect(() => new ToolRegistry([{ name: "a", tools: [tool("x")] }, { name: "b", tools: [tool("x")] }])).toThrow(/"a" and "b"/);
    expect(() => new ToolRegistry([{ name: "a", tools: [] }, { name: "a", tools: [] }])).toThrow(/toolset name "a"/);
  });

  it("rejects invalid names and malformed tools", () => {
    for (const name of ["", "has space", "x".repeat(65), "ünicode", "a/b", "__proto__\n"]) {
      expect(() => new ToolRegistry([{ name: "s", tools: [tool(name)] }])).toThrow(/tool name/);
    }
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", ["read"], { description: "  " })] }])).toThrow(/description/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", [])] }])).toThrow(/capabilities/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", ["root" as ToolCapability])] }])).toThrow(/unknown capability/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", ["read"], { input: {} as never })] }])).toThrow(/zod/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", ["read"], { run: "no" as never })] }])).toThrow(/run/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", ["internal.write"], { readOnly: true })] }])).toThrow(/read-only/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("x", ["read"], { input: z.string() as never })] }])).toThrow(/z\.object/);
  });

  it("refuses a messaging tool unless the app opts in for owner messages", () => {
    const sms = tool("send_sms", ["messaging"]);
    expect(() => new ToolRegistry([{ name: "s", tools: [sms] }])).toThrow(/messaging/);
    expect(() => new ToolRegistry([{ name: "s", tools: [tool("mixed", ["read", "messaging"], { readOnly: false })] }])).toThrow(/messaging/);
    const allowed = new ToolRegistry([{ name: "s", tools: [sms] }], { allowOwnerMessaging: true });
    expect(allowed.has("send_sms")).toBe(true);
    // The opt-in carries over to derived registries; without() still removes it.
    expect(allowed.without(["messaging"]).has("send_sms")).toBe(false);
  });

  it("without(capabilities) and only(toolsets) return new registries", () => {
    const registry = new ToolRegistry([
      { name: "core", tools: [tool("read_x"), tool("write_x", ["internal.write"]), tool("remember", ["memory.write"])] },
      { name: "ops", tools: [tool("schedule", ["scheduling"]), tool("delegate", ["delegation"])] },
    ]);
    const child = registry.without(["memory.write", "scheduling", "delegation"]);
    expect(child.names()).toEqual(["read_x", "write_x"]);
    expect(registry.size).toBe(5);
    expect(registry.only(["ops"]).names()).toEqual(["delegate", "schedule"]);
    expect(() => registry.only(["nope"])).toThrow(/no toolset/);
    expect(registry.toolsets().map((s) => [s.name, s.tools.map((t) => t.name)])).toEqual([
      ["core", ["read_x", "remember", "write_x"]],
      ["ops", ["delegate", "schedule"]],
    ]);
  });

  it("keeps a frozen copy: changing the definition later changes nothing", () => {
    const def = tool("safe_read");
    const registry = new ToolRegistry([{ name: "s", tools: [def] }]);
    def.capabilities.push("external.write");
    def.readOnly = false;
    def.name = "renamed";
    const stored = registry.get("safe_read");
    expect(stored?.capabilities).toEqual(["read"]);
    expect(stored?.readOnly).toBe(true);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(registry.get("renamed")).toBeUndefined();
  });

  it("get() never matches inherited keys", () => {
    const registry = new ToolRegistry([{ name: "s", tools: [tool("x")] }]);
    expect(registry.get("constructor")).toBeUndefined();
    expect(registry.get("__proto__")).toBeUndefined();
    expect(registry.get(42 as never)).toBeUndefined();
  });
});
