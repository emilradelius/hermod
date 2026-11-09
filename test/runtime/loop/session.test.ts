import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../../../src/loop/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { defineTool } from "../../../src/tools/define.js";
import { AgentOffError, MEMORY_SEPARATOR } from "../../../src/types.js";
import { AGENT, baseConfig, countingStorage, noSleep, setup } from "./helpers.js";

describe("runAgent: mode off", () => {
  it("throws AgentOffError with zero model calls and zero storage writes", async () => {
    const inner = await setup("off");
    const { storage, writes } = countingStorage(inner);
    const model = new FakeModelClient([textMessage("never")]);
    const ran: string[] = [];
    const tool = defineTool({
      name: "save",
      description: "Save. Use it to save.",
      input: z.object({}),
      readOnly: false,
      capabilities: ["internal.write"],
      run: () => void ran.push("save"),
    });
    await expect(
      runAgent(baseConfig([{ name: "t", tools: [tool] }]), { userMessage: "hello" }, { storage, model, sleep: noSleep }),
    ).rejects.toBeInstanceOf(AgentOffError);
    expect(model.calls).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(ran).toEqual([]);
    expect(await inner.sessions.listByAgent(AGENT)).toEqual([]);
  });

  it("an agent turned off during a run stops before the next call", async () => {
    const storage = await setup("autonomous");
    const off = defineTool({
      name: "lookup",
      description: "Look something up. Use it to look.",
      input: z.object({}),
      readOnly: true,
      capabilities: ["read"],
      run: async () => {
        await storage.agents.update(AGENT, { mode: "off" });
        return "found";
      },
    });
    const model = new FakeModelClient([toolUseMessage([{ name: "lookup", input: {} }]), textMessage("never")]);
    const result = await runAgent(baseConfig([{ name: "t", tools: [off] }]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("aborted");
    expect(model.calls).toHaveLength(1);
  });
});

describe("runAgent: the frozen snapshot", () => {
  it("is identical in every request of a session even after a memory store changes mid-session; a new session sees the change", async () => {
    const storage = await setup("autonomous");
    const store = await storage.memory.ensureStore(AGENT, "memory", { capChars: 2_000, autoApply: "none" });
    await storage.memory.writeContent(store.id, "The build uses pnpm.", store.version);
    const changer = defineTool({
      name: "approve_change",
      description: "Simulates a person approving a memory change. Use it in tests.",
      input: z.object({}),
      readOnly: false,
      capabilities: ["internal.write"],
      run: async () => {
        const current = await storage.memory.getStore(AGENT, "memory");
        if (!current) throw new Error("no store");
        await storage.memory.writeContent(current.id, `The build uses npm.${MEMORY_SEPARATOR}Tests run with vitest.`, current.version);
        return "approved";
      },
    });
    const config = baseConfig([{ name: "t", tools: [changer] }]);
    const model = new FakeModelClient([toolUseMessage([{ name: "approve_change", input: {} }]), textMessage("first done")]);
    const first = await runAgent(config, { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.system).toEqual(model.calls[1]?.system);
    expect(model.calls[0]?.system[1]?.text).toContain("The build uses pnpm.");
    expect(model.calls[1]?.system[1]?.text).not.toContain("Tests run with vitest.");

    // Continue the same session: still the frozen snapshot, never recomputed.
    const again = new FakeModelClient([textMessage("still frozen")]);
    await runAgent(config, { userMessage: "and now?", sessionId: first.sessionId }, { storage, model: again, sleep: noSleep });
    expect(again.calls[0]?.system).toEqual(model.calls[0]?.system);

    // A new session sees the change.
    const fresh = new FakeModelClient([textMessage("new")]);
    await runAgent(config, { userMessage: "new session" }, { storage, model: fresh, sleep: noSleep });
    expect(fresh.calls[0]?.system[1]?.text).toContain("Tests run with vitest.");
    expect(fresh.calls[0]?.system[1]?.text).not.toContain("pnpm");
    // The stable block is the same in both sessions (cache-friendly).
    expect(fresh.calls[0]?.system[0]).toEqual(model.calls[0]?.system[0]);
  });

  it("stores the snapshot and skills index on the session row, and uses injected knowledge", async () => {
    const storage = await setup();
    const asked: string[] = [];
    const knowledge = {
      async snapshot(agentId: string, stores: string[]) {
        asked.push(`snapshot:${agentId}:${stores.join(",")}`);
        return "Fact one.";
      },
      async skillsIndex() {
        asked.push("index");
        return "release-notes: Write release notes";
      },
    };
    const model = new FakeModelClient([textMessage("a"), textMessage("b")]);
    const first = await runAgent(baseConfig([], { memoryStores: ["memory"] }), { userMessage: "x" }, { storage, model, knowledge });
    await runAgent(baseConfig(), { userMessage: "y", sessionId: first.sessionId }, { storage, model, knowledge });
    expect(asked).toEqual([`snapshot:${AGENT}:memory`, "index"]);
    const session = await storage.sessions.get(first.sessionId);
    expect(session?.memorySnapshot).toBe("Fact one.");
    expect(session?.skillsIndex).toBe("release-notes: Write release notes");
    expect(model.calls[0]?.system[1]?.text).toContain("release-notes: Write release notes");
  });

  it("attaches skill bodies for the session (jobs) and keeps them frozen", async () => {
    const storage = await setup();
    await storage.skills.create({ agentId: AGENT, name: "weekly-report", description: "Write the weekly report.", body: "Step 1: gather.", createdBy: "test" });
    const model = new FakeModelClient([textMessage("a")]);
    const result = await runAgent(baseConfig([], { attachSkills: ["weekly-report"] }), { userMessage: "x" }, { storage, model });
    expect(model.calls[0]?.system[1]?.text).toContain("Step 1: gather.");
    expect(model.calls[0]?.system[1]?.text).toContain("weekly-report: Write the weekly report.");
    const session = await storage.sessions.get(result.sessionId);
    expect(session?.meta.attachedSkillNames).toEqual(["weekly-report"]);
  });
});
