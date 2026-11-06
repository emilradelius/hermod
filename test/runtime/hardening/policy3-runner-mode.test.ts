/**
 * Hardening round 3, policy block (R6): the SDK Tool Runner adapter decides with the agent's STORED mode. Off or
 * shadow set in storage applies to the adapter's calls whatever ctx.mode says; an agent with no row, or a row that
 * cannot be read, counts as off.
 */
import { describe, expect, it } from "vitest";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { setMode } from "../../../src/modes/index.js";
import { toBetaZodTool, toBetaZodTools, ToolRegistry } from "../../../src/tools/index.js";
import type { Storage, ToolContext, ToolDef } from "../../../src/types.js";
import { AGENT, OWNER, entries, toolCtx, world, type World } from "./policy-helpers.js";

function byName(w: World, name: string): ToolDef {
  return [...w.notes.tools, ...w.knowledge.tools].find((t) => t.name === name) as ToolDef;
}

async function chat(w: World): Promise<string> {
  const session = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
  return session.id;
}

/** The app's ToolContext always claims an autonomous, attended, clean run. */
const autonomousCtx = (storage: Storage, sessionId: string) => (): ToolContext => toolCtx(storage, sessionId, { mode: "autonomous" });

describe("R6: the Tool Runner adapter reads the stored agent mode", () => {
  it("off in storage: a side effect and a read-only call are both denied, though ctx.mode says autonomous", async () => {
    const w = await world({ mode: "off" });
    const sessionId = await chat(w);
    const save = toBetaZodTool(byName(w, "save_note"), autonomousCtx(w.storage, sessionId));
    const read = toBetaZodTool(byName(w, "read_note"), autonomousCtx(w.storage, sessionId));
    await expect(save.run({ text: "x" })).rejects.toBeInstanceOf(ToolError);
    await expect(read.run({ id: "1" })).rejects.toBeInstanceOf(ToolError);
    expect(w.executed).toEqual([]);
    expect(await w.storage.proposals.list({ agentId: AGENT })).toEqual([]);
    const denials = await w.storage.audit.list({ action: "tool.deny" });
    expect(denials.map((a) => a.target).sort()).toEqual(["read_note", "save_note"]);
  });

  it("turned off between two calls of the same adapter tool: the second call does not run", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const save = toBetaZodTool(byName(w, "save_note"), autonomousCtx(w.storage, sessionId));
    expect(String(await save.run({ text: "first" }))).toBe("done");
    await setMode(w.storage, AGENT, "off", OWNER);
    await expect(save.run({ text: "second" })).rejects.toThrow(/off/);
    expect(w.executed).toEqual(["save_note:first"]);
  });

  it("shadow in storage: a side effect becomes a shadow draft and never runs", async () => {
    const w = await world({ mode: "shadow" });
    const sessionId = await chat(w);
    const [save] = toBetaZodTools(new ToolRegistry([{ name: "app", tools: [byName(w, "save_note")] }]), autonomousCtx(w.storage, sessionId));
    expect(String(await save?.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
    const drafts = await w.storage.proposals.list({ agentId: AGENT });
    expect(drafts.map((p) => [p.kind, p.target, p.shadow])).toEqual([["action", "save_note", true]]);
  });

  it("shadow in storage reaches the tool's context: the built-in memory tool never writes an add-only store directly", async () => {
    const w = await world({ mode: "shadow" });
    const sessionId = await chat(w);
    const memory = toBetaZodTool(byName(w, "memory"), autonomousCtx(w.storage, sessionId));
    const out = String(await memory.run({ store: "user", ops: [{ op: "add", text: "User prefers metric units." }] }));
    expect(out).not.toContain("Saved.");
    expect(await entries(w, "user")).toEqual([]);
  });

  it("supervised in storage: a side effect is proposed, though ctx.mode says autonomous", async () => {
    const w = await world({ mode: "supervised" });
    const sessionId = await chat(w);
    const save = toBetaZodTool(byName(w, "save_note"), autonomousCtx(w.storage, sessionId));
    expect(String(await save.run({ text: "x" }))).toContain("proposed");
    expect(w.executed).toEqual([]);
  });

  it("an agent with no stored row counts as off (fail closed)", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const ghost = (): ToolContext => ({ ...toolCtx(w.storage, sessionId), agentId: "no-such-agent" });
    await expect(toBetaZodTool(byName(w, "save_note"), ghost).run({ text: "x" })).rejects.toBeInstanceOf(ToolError);
    await expect(toBetaZodTool(byName(w, "read_note"), ghost).run({ id: "1" })).rejects.toBeInstanceOf(ToolError);
    expect(w.executed).toEqual([]);
  });

  it("an agent row that cannot be read counts as off (fail closed)", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const broken: Storage = {
      ...w.storage,
      agents: {
        ...w.storage.agents,
        get: async () => {
          throw new Error("database down");
        },
      },
    };
    const save = toBetaZodTool(byName(w, "save_note"), autonomousCtx(broken, sessionId));
    await expect(save.run({ text: "x" })).rejects.toBeInstanceOf(ToolError);
    expect(w.executed).toEqual([]);
  });

  it("the round re-reads the stored mode before its decision (ToolEnv.currentMode): off read then wins", async () => {
    const w = await world();
    const sessionId = await chat(w);
    let reads = 0;
    const flipping: Storage = {
      ...w.storage,
      agents: {
        ...w.storage.agents,
        get: async (id) => {
          reads += 1;
          const row = await w.storage.agents.get(id);
          // The first read says autonomous; by the time the round decides, the agent was turned off.
          return row && reads > 1 ? { ...row, mode: "off" } : row;
        },
      },
    };
    const save = toBetaZodTool(byName(w, "save_note"), autonomousCtx(flipping, sessionId));
    await expect(save.run({ text: "x" })).rejects.toThrow(/turned off/);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(w.executed).toEqual([]);
  });

  it("an autonomous stored mode still runs a clean side effect (the stored mode is used, not only stricter ones)", async () => {
    const w = await world();
    const sessionId = await chat(w);
    const ctx = (): ToolContext => toolCtx(w.storage, sessionId, { mode: "supervised" });
    expect(String(await toBetaZodTool(byName(w, "save_note"), ctx).run({ text: "x" }))).toBe("done");
    expect(w.executed).toEqual(["save_note:x"]);
  });
});
