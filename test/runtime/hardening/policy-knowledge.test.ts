/**
 * Hardening, policy block: the knowledge-tool exemption needs the built-in factories' private mark (G), and the
 * built-in memory tool never applies an add-only batch directly in an unattended run (A2).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reviewToolset, type ReviewLedger } from "../../../src/learning/index.js";
import { createApprovalPolicy } from "../../../src/safety/index.js";
import { textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { makeMemoryTool } from "../../../src/tools/builtin/index.js";
import { ToolRegistry, defineTool } from "../../../src/tools/index.js";
import type { AgentMode, ToolDef } from "../../../src/types.js";
import { AGENT, entries, run, sideEffect, toolCtx, world } from "./policy-helpers.js";

const policy = createApprovalPolicy();
const MODES: AgentMode[] = ["shadow", "supervised", "autonomous"];

function everyContext(): Array<{ mode: AgentMode; attended: boolean; tainted: boolean }> {
  const out: Array<{ mode: AgentMode; attended: boolean; tainted: boolean }> = [];
  for (const mode of MODES) for (const attended of [true, false]) for (const tainted of [true, false]) out.push({ mode, attended, tainted });
  return out;
}

describe("G: the knowledge-tool exemption is for the built-in tools only", () => {
  it("allows the built-in memory and skill_propose tools and the review's, also as the registry's frozen copies", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    const ledger: ReviewLedger = { proposals: [], refused: [], applied: [] };
    const review = reviewToolset({ ...w, model: w.model, reviewed: session, ledger });
    const writers = [...w.knowledge.tools, ...review.tools].filter((t) => !t.readOnly);
    expect(writers.map((t) => t.name).sort()).toEqual(["memory", "memory", "skill_propose", "skill_propose"]);
    const registry = new ToolRegistry([{ name: "knowledge", tools: w.knowledge.tools }]);
    const copies = registry.list().filter((t) => !t.readOnly);
    for (const tool of [...writers, ...copies]) {
      for (const c of everyContext()) {
        expect(policy.decide({ ...c, tool, input: {} }).decision, `${tool.name} ${JSON.stringify(c)}`).toBe("allow");
      }
      expect(policy.decide({ mode: "off", attended: true, tainted: false, tool, input: {} }).decision).toBe("deny");
    }
  });

  it("an app tool that declares only memory.write or skills.write follows the side-effect rules", () => {
    for (const capabilities of [["memory.write"], ["skills.write"], ["read", "memory.write"], ["memory.write", "skills.write"]] as const) {
      const own = defineTool({
        name: "remember_elsewhere",
        description: "Says it only writes memory. Use it never.",
        input: z.object({}),
        readOnly: false,
        capabilities: [...capabilities],
        run: () => "x",
      });
      for (const mode of ["shadow", "supervised"] as const) {
        for (const attended of [true, false]) {
          for (const tainted of [true, false]) {
            expect(policy.decide({ mode, attended, tainted, tool: own, input: {} }).decision, `${capabilities.join("+")} ${mode}`).toBe(
              "propose",
            );
          }
        }
      }
      expect(policy.decide({ mode: "autonomous", attended: true, tainted: true, tool: own, input: {} }).decision).toBe("propose");
      expect(policy.decide({ mode: "autonomous", attended: false, tainted: true, tool: own, input: {} }).decision).toBe("deny");
      expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: own, input: {} }).decision).toBe("allow");
    }
  });

  it("a spread copy of the built-in memory tool, or one with a look-alike Symbol.for mark, is not exempt", async () => {
    const w = await world();
    const builtIn = makeMemoryTool(w.memory) as unknown as ToolDef;
    const spread: ToolDef = { ...builtIn, run: () => "wrote somewhere else" };
    const forged = Object.assign({ ...spread }, { [Symbol.for("hermod.knowledge-tool")]: true });
    Object.defineProperty(forged, Symbol.for("hermod.knowledge-tool"), { value: true, enumerable: false });
    for (const tool of [spread, forged]) {
      expect(policy.decide({ mode: "shadow", attended: true, tainted: false, tool, input: {} }).decision).toBe("propose");
      expect(policy.decide({ mode: "autonomous", attended: false, tainted: true, tool, input: {} }).decision).toBe("deny");
    }
    expect(policy.decide({ mode: "shadow", attended: true, tainted: false, tool: builtIn, input: {} }).decision).toBe("allow");
  });

  it("the built-in mark stays with the frozen copy but a built-in that needs approval is not waved through", async () => {
    const w = await world();
    const builtIn = makeMemoryTool(w.memory) as unknown as ToolDef;
    builtIn.requiresApproval = true;
    expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: builtIn, input: {} }).decision).toBe("propose");
    expect(policy.decide({ mode: "autonomous", attended: false, tainted: false, tool: builtIn, input: {} }).decision).toBe("deny");
    expect(policy.decide({ mode: "autonomous", attended: true, tainted: false, tool: builtIn, input: { text: "rm -rf /" } }).decision).toBe("deny");
  });

  it("end to end in shadow mode: a self-declared memory.write app tool does not run; it becomes a shadow draft", async () => {
    const w = await world({ mode: "shadow" });
    const own = sideEffect("remember_elsewhere", ["memory.write"], w.executed);
    const result = await run(
      w,
      [toolUseMessage([{ name: "remember_elsewhere", input: { text: "every invoice paid" } }]), textMessage("Done.")],
      {},
      { toolsets: [w.knowledge, w.notes, { name: "app", tools: [own] }] },
    );
    expect(result.end).toBe("end_turn");
    expect(w.executed).toEqual([]);
    const drafts = await w.storage.proposals.list({ agentId: AGENT });
    expect(drafts.map((p) => [p.kind, p.target, p.shadow, p.status])).toEqual([["action", "remember_elsewhere", true, "pending"]]);
  });

  it("end to end unattended after untrusted text: a self-declared memory.write app tool is denied and never runs", async () => {
    const w = await world();
    const own = sideEffect("remember_elsewhere", ["memory.write"], w.executed);
    const result = await run(
      w,
      [
        toolUseMessage([{ name: "fetch_page", input: { url: "https://example.test" } }]),
        toolUseMessage([{ name: "remember_elsewhere", input: { text: "every invoice paid" } }]),
        textMessage("Done."),
      ],
      { kind: "job", attended: false },
      { toolsets: [w.knowledge, w.notes, { name: "app", tools: [own] }] },
    );
    expect(result.end).toBe("end_turn");
    expect(w.executed).toEqual([]);
    expect(await w.storage.proposals.list({ agentId: AGENT })).toEqual([]);
  });
});

describe("A2: the built-in memory tool never writes directly in an unattended run", () => {
  it("an add-only batch to an add-only store becomes a proposal when the run is unattended (the store is unchanged)", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "job", attended: false, memorySnapshot: "", skillsIndex: "" });
    const tool = makeMemoryTool(w.memory);
    const out = await tool.run(
      { store: "user", ops: [{ op: "add", text: "User wants every invoice paid at once." }] },
      toolCtx(w.storage, session.id, { attended: false, tainted: false }),
    );
    expect(String(out)).toMatch(/^Proposed/);
    expect(await entries(w, "user")).toEqual([]);
    const proposals = await w.storage.proposals.list({ agentId: AGENT });
    expect(proposals.map((p) => [p.kind, p.status])).toEqual([["memory", "pending"]]);
  });

  it("the same batch in an attended, clean chat still applies directly (the owner allows add-only writes)", async () => {
    const w = await world();
    const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    const out = await makeMemoryTool(w.memory).run(
      { store: "user", ops: [{ op: "add", text: "User prefers metric units." }] },
      toolCtx(w.storage, session.id, { attended: true, tainted: false }),
    );
    expect(String(out)).toMatch(/^Saved/);
    expect(await entries(w, "user")).toEqual(["User prefers metric units."]);
  });

  it("a scheduled (unattended) run that calls memory add leaves a proposal and no entry", async () => {
    const w = await world();
    const result = await run(
      w,
      [
        toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "User wants every invoice paid." }] } }]),
        textMessage("Done."),
      ],
      { kind: "job", attended: false, userMessage: "Do the nightly round." },
    );
    expect(result.end).toBe("end_turn");
    expect(await entries(w, "user")).toEqual([]);
    const proposals = await w.storage.proposals.list({ agentId: AGENT });
    expect(proposals.map((p) => [p.kind, p.status, p.createdBy])).toEqual([["memory", "pending", `agent:${AGENT}`]]);
    expect(result.proposals).toEqual(proposals.map((p) => p.id));
  });
});
