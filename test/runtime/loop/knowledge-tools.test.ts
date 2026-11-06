/** End to end: the knowledge tools inside runAgent are governed by their own proposal services, not double-wrapped. */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../../src/loop/index.js";
import { knowledgeDeps, MemoryService } from "../../../src/memory/index.js";
import { ProposalService } from "../../../src/proposals/index.js";
import { SkillService } from "../../../src/skills/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { knowledgeToolset } from "../../../src/tools/builtin/index.js";
import type { AgentMode } from "../../../src/types.js";
import { AGENT, baseConfig, noSleep, setup } from "./helpers.js";

async function run(mode: AgentMode, autoApply: "none" | "add") {
  const storage = await setup(mode);
  const memory = new MemoryService({ storage });
  const skills = new SkillService({ storage });
  const proposals = new ProposalService({ storage, memory, skills });
  await memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply }]);
  const model = new FakeModelClient([
    toolUseMessage([{ name: "memory", input: { store: "user", ops: [{ op: "add", text: "User plans the day at 08:30." }] } }]),
    textMessage("Noted."),
  ]);
  const result = await runAgent(
    baseConfig([knowledgeToolset({ memory, skills, proposals, storage })]),
    { userMessage: "I always plan my day at 08:30." },
    { storage, model, sleep: noSleep, knowledge: knowledgeDeps({ memory, skills }) },
  );
  const all = await storage.proposals.list({ agentId: AGENT });
  return { result, all, entries: await memory.entries(AGENT, "user") };
}

describe("runAgent with the knowledge tools", () => {
  it("shadow mode: the memory write becomes one memory proposal, not an action proposal, and nothing is applied", async () => {
    const { result, all, entries } = await run("shadow", "add");
    expect(result.end).toBe("end_turn");
    expect(all.map((p) => p.kind)).toEqual(["memory"]);
    expect(all[0]?.status).toBe("pending");
    expect(entries).toEqual([]);
  });

  it("supervised mode with a store that allows no direct writes: one pending memory proposal", async () => {
    const { all, entries } = await run("supervised", "none");
    expect(all.map((p) => p.kind)).toEqual(["memory"]);
    expect(entries).toEqual([]);
  });

  it("autonomous mode, clean session, owner allows add-only: the add applies directly and no proposal is made", async () => {
    const { all, entries } = await run("autonomous", "add");
    expect(all).toEqual([]);
    expect(entries).toEqual(["User plans the day at 08:30."]);
  });
});
