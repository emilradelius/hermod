/**
 * Hardening round 3, policy block (R10): the knowledge-tool exemption is bound to the factory's own run function.
 * Replacing run (on the factory's object or a copy) loses it, and there is no property on the tool that could be
 * read and set on another tool.
 */
import { describe, expect, it } from "vitest";
import { createApprovalPolicy } from "../../../src/safety/index.js";
import { textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { makeMemoryTool, makeSkillTools } from "../../../src/tools/builtin/index.js";
import { ToolRegistry } from "../../../src/tools/index.js";
import { isBuiltInKnowledgeTool } from "../../../src/tools/knowledge-mark.js";
import type { ToolDef, Toolset } from "../../../src/types.js";
import { AGENT, entries, run, sideEffect, world } from "./policy-helpers.js";

const policy = createApprovalPolicy();

/** Exempt: allowed in shadow mode and unattended after untrusted text (an ordinary side effect is not). */
function exempt(tool: ToolDef): boolean {
  return (
    policy.decide({ mode: "shadow", attended: true, tainted: false, tool, input: {} }).decision === "allow" &&
    policy.decide({ mode: "autonomous", attended: false, tainted: true, tool, input: {} }).decision === "allow"
  );
}

describe("R10: the knowledge-tool exemption follows the factory's run function", () => {
  it("the factory's own object, and the registry's frozen copy of it, are exempt", async () => {
    const w = await world();
    const builtIn = makeMemoryTool(w.memory) as unknown as ToolDef;
    expect(exempt(builtIn)).toBe(true);
    const copy = new ToolRegistry([{ name: "k", tools: [builtIn] }]).get("memory") as ToolDef;
    expect(copy).not.toBe(builtIn);
    expect(exempt(copy)).toBe(true);
  });

  it("replacing run on the factory's own object loses the exemption", async () => {
    const w = await world();
    const builtIn = makeMemoryTool(w.memory) as unknown as ToolDef;
    builtIn.run = () => "wrote somewhere else";
    expect(isBuiltInKnowledgeTool(builtIn)).toBe(false);
    expect(policy.decide({ mode: "shadow", attended: true, tainted: false, tool: builtIn, input: {} }).decision).toBe("propose");
    expect(policy.decide({ mode: "autonomous", attended: false, tainted: true, tool: builtIn, input: {} }).decision).toBe("deny");
    // Registered after the change: the registry's copy is not exempt either.
    const copy = new ToolRegistry([{ name: "k", tools: [builtIn] }]).get("memory") as ToolDef;
    expect(exempt(copy)).toBe(false);
  });

  it("replacing run on skill_propose loses it too", async () => {
    const w = await world();
    const propose = makeSkillTools(w.skills, w.proposals)[2] as unknown as ToolDef;
    expect(exempt(propose)).toBe(true);
    propose.run = () => "elsewhere";
    expect(exempt(propose)).toBe(false);
  });

  it("the tool carries no symbol to steal: copying every own property, symbols included, onto an app tool earns nothing", async () => {
    const w = await world();
    const builtIn = makeMemoryTool(w.memory) as unknown as ToolDef;
    const registryCopy = new ToolRegistry([{ name: "k", tools: [builtIn] }]).get("memory") as ToolDef;
    for (const source of [builtIn, registryCopy]) {
      expect(Object.getOwnPropertySymbols(source)).toEqual([]);
      const app = sideEffect("remember_elsewhere", ["memory.write"], w.executed);
      for (const key of Reflect.ownKeys(source)) {
        if (key === "run" || key === "name") continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor) Object.defineProperty(app, key, { ...descriptor, configurable: true });
      }
      expect(exempt(app)).toBe(false);
    }
  });

  it("an object that is not a tool, or has a getter that throws, is never exempt", () => {
    expect(isBuiltInKnowledgeTool(null)).toBe(false);
    expect(isBuiltInKnowledgeTool(() => "x")).toBe(false);
    const hostile = Object.defineProperty({}, "run", {
      get() {
        throw new Error("no");
      },
    });
    expect(isBuiltInKnowledgeTool(hostile)).toBe(false);
  });

  it("end to end in shadow mode: a built-in memory tool whose run was replaced does not run; it becomes a shadow draft", async () => {
    const w = await world({ mode: "shadow" });
    const ran: string[] = [];
    const patched = makeMemoryTool(w.memory) as unknown as ToolDef;
    patched.run = () => {
      ran.push("patched");
      return "wrote somewhere else";
    };
    const knowledge: Toolset = { name: "knowledge", tools: [patched] };
    const result = await run(
      w,
      [toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "every invoice paid" }] } }]), textMessage("Done.")],
      {},
      { toolsets: [knowledge, w.notes] },
    );
    expect(result.end).toBe("end_turn");
    expect(ran).toEqual([]);
    expect(await entries(w, "user")).toEqual([]);
    const drafts = await w.storage.proposals.list({ agentId: AGENT });
    expect(drafts.map((p) => [p.kind, p.target, p.shadow])).toEqual([["action", "memory", true]]);
  });
});
