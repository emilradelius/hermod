/** RunResult.proposals: every proposal created during the run in its session (action, memory, skill), once, in order. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeDelegateTool, runAgent } from "../../../src/loop/index.js";
import { knowledgeDeps, MemoryService } from "../../../src/memory/index.js";
import { ProposalService } from "../../../src/proposals/index.js";
import { SkillService } from "../../../src/skills/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { knowledgeToolset } from "../../../src/tools/builtin/index.js";
import { defineTool } from "../../../src/tools/define.js";
import type { AgentConfig, AgentMode, Toolset } from "../../../src/types.js";
import { AGENT, baseConfig, makeTools, noSleep, setup } from "./helpers.js";

async function world(mode: AgentMode) {
  const storage = await setup(mode);
  const memory = new MemoryService({ storage });
  const skills = new SkillService({ storage });
  const proposals = new ProposalService({ storage, memory, skills });
  await memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply: "none" }]);
  const tools = makeTools();
  const invoice = defineTool({
    name: "send_invoice",
    description: "Send an invoice. Use it when the user asks.",
    input: z.object({ to: z.string() }),
    readOnly: false,
    capabilities: ["external.write"],
    requiresApproval: true,
    run: () => "sent",
  });
  const extra: Toolset = { name: "extra", tools: [invoice, makeDelegateTool()] };
  const config = (overrides: Partial<AgentConfig> = {}) =>
    baseConfig([knowledgeToolset({ memory, skills, proposals, storage }), tools.set, extra], overrides);
  const deps = (model: FakeModelClient) => ({ storage, model, sleep: noSleep, knowledge: knowledgeDeps({ memory, skills }) });
  /** The ids of the session's proposals, oldest first. */
  const inSession = async (sessionId: string) => (await storage.proposals.list({ sessionId })).reverse().map((p) => p.id);
  return { storage, config, deps, inSession };
}

const memoryAdd = (text: string) => ({ name: "memory", input: { store: "user", ops: [{ op: "add", text }] } });
const skillCreate = {
  name: "skill_propose",
  input: {
    skill: "weekly-review",
    changes: [{ change: "create", description: "Run the weekly review. Use it on Fridays.", body: "1. Pick five items." }],
    rationale: "The user's own routine.",
  },
};

describe("RunResult.proposals", () => {
  it("lists the memory, skill and action proposals of the run, each once, in creation order", async () => {
    const w = await world("supervised");
    const result = await runAgent(
      w.config(),
      { userMessage: "remember, learn and save" },
      w.deps(
        new FakeModelClient([
          toolUseMessage([memoryAdd("User likes tea."), { name: "save_note", input: { text: "a" } }]),
          toolUseMessage([skillCreate]),
          textMessage("All queued."),
        ]),
      ),
    );
    expect(result.end).toBe("end_turn");
    const kinds = await Promise.all(result.proposals.map(async (id) => (await w.storage.proposals.get(id))?.kind));
    expect(kinds).toEqual(["memory", "action", "skill"]);
    expect(result.proposals).toEqual(await w.inSession(result.sessionId));
    expect(new Set(result.proposals).size).toBe(3);
    // The action proposal is the one the tool call record points to.
    expect(result.toolCalls.find((c) => c.name === "save_note")?.proposalId).toBe(result.proposals[1]);
  });

  it("a continued session lists only the proposals of this run", async () => {
    const w = await world("supervised");
    const first = await runAgent(
      w.config(),
      { userMessage: "remember" },
      w.deps(new FakeModelClient([toolUseMessage([memoryAdd("User likes tea.")]), textMessage("Queued.")])),
    );
    expect(first.proposals).toHaveLength(1);
    const second = await runAgent(
      w.config(),
      { userMessage: "and this", sessionId: first.sessionId },
      w.deps(new FakeModelClient([toolUseMessage([memoryAdd("User likes coffee."), skillCreate]), textMessage("Queued.")])),
    );
    const all = await w.inSession(first.sessionId);
    expect(all).toHaveLength(3);
    expect(second.proposals).toEqual(all.slice(1));
    expect(second.proposals).not.toContain(first.proposals[0]);
  });

  it("a delegate child's proposals come in creation order between the parent's", async () => {
    const w = await world("autonomous");
    const result = await runAgent(
      w.config({ budget: { maxCostUsd: 1 } }),
      { userMessage: "do it all" },
      w.deps(
        new FakeModelClient([
          // Parent round 1: a memory proposal, then a child that queues an invoice.
          toolUseMessage([memoryAdd("User likes tea."), { name: "delegate", input: { task: "Invoice the customer." } }]),
          toolUseMessage([{ name: "send_invoice", input: { to: "child" } }]),
          textMessage("Child queued the invoice."),
          // Parent round 2: its own invoice.
          toolUseMessage([{ name: "send_invoice", input: { to: "parent" } }]),
          textMessage("Done."),
        ]),
      ),
    );
    expect(result.end).toBe("end_turn");
    const described = await Promise.all(
      result.proposals.map(async (id) => {
        const p = await w.storage.proposals.get(id);
        return [p?.kind, p?.sessionId === result.sessionId ? "parent" : "child", JSON.stringify(p?.payload)];
      }),
    );
    expect(described.map(([kind, owner]) => [kind, owner])).toEqual([
      ["memory", "parent"],
      ["action", "child"],
      ["action", "parent"],
    ]);
    expect(described[1]?.[2]).toContain("child");
    expect(described[2]?.[2]).toContain("parent");
  });

  it("a run that ends early (budget) still lists the proposals it made", async () => {
    const w = await world("supervised");
    const result = await runAgent(
      w.config({ budget: { maxIterations: 1 } }),
      { userMessage: "remember" },
      w.deps(new FakeModelClient([toolUseMessage([memoryAdd("User likes tea."), { name: "save_note", input: { text: "a" } }])])),
    );
    expect(result.end).toBe("budget_iterations");
    expect(result.proposals).toEqual(await w.inSession(result.sessionId));
    expect(result.proposals).toHaveLength(2);
  });

  it("proposals a post-session review makes in the same session meanwhile are not the run's", async () => {
    const w = await world("supervised");
    const reviewLike = defineTool({
      name: "lookup",
      description: "Look something up. Use it to look.",
      input: z.object({}),
      readOnly: true,
      capabilities: ["read"],
      // Simulates a review of this session finishing while the run is going on.
      run: async (_input, ctx) => {
        await ctx.storage.proposals.create({
          agentId: AGENT,
          sessionId: ctx.sessionId,
          kind: "memory",
          target: "user",
          payload: { kind: "memory", store: "user", ops: [{ op: "add", text: "User likes walks." }] },
          evidence: [],
          rationale: "From the review.",
          createdBy: "review",
        });
        return "found";
      },
    });
    const result = await runAgent(
      baseConfig([{ name: "r", tools: [reviewLike] }, ...(w.config().toolsets ?? [])]),
      { userMessage: "look and remember" },
      w.deps(new FakeModelClient([toolUseMessage([{ name: "lookup", input: {} }, memoryAdd("User likes tea.")]), textMessage("Ok.")])),
    );
    const all = await w.inSession(result.sessionId);
    expect(all).toHaveLength(2);
    expect(result.proposals).toEqual([all[1]]);
  });

  it("a write that applies directly (add-only store, clean session) is not a proposal and is not listed", async () => {
    const storage = await setup("autonomous");
    const memory = new MemoryService({ storage });
    const skills = new SkillService({ storage });
    const proposals = new ProposalService({ storage, memory, skills });
    await memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply: "add" }]);
    const result = await runAgent(
      baseConfig([knowledgeToolset({ memory, skills, proposals, storage })]),
      { userMessage: "remember" },
      { storage, model: new FakeModelClient([toolUseMessage([memoryAdd("User likes tea.")]), textMessage("Saved.")]), sleep: noSleep },
    );
    expect(result.proposals).toEqual([]);
    expect(await memory.entries(AGENT, "user")).toEqual(["User likes tea."]);
  });
});
