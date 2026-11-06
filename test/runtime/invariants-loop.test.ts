/**
 * Loop invariants added by the hardening pass (finding M; invariant 5 of test/runtime/invariants.test.ts): off means
 * off and shadow runs no side effects, also when the mode changes DURING a tool round. The agent's mode is re-read
 * from storage before every side-effecting decision, so a later call in the same round follows the new mode.
 *
 * These tests must never be weakened to make something pass (CLAUDE.md: "The agent only proposes").
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent } from "../../src/loop/index.js";
import { knowledgeDeps, MemoryService } from "../../src/memory/index.js";
import { ProposalService } from "../../src/proposals/index.js";
import { SkillService } from "../../src/skills/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../src/testing/index.js";
import { knowledgeToolset } from "../../src/tools/builtin/index.js";
import { defineTool } from "../../src/tools/define.js";
import type { AgentMode, Storage, ToolDef } from "../../src/types.js";
import { AGENT, baseConfig, makeTools, noSleep, setup } from "./loop/helpers.js";

/** A read tool that stands in for a person changing the agent's mode while the round is going on. */
function modeSwitch(storage: Storage, mode: AgentMode): ToolDef {
  return defineTool({
    name: "owner_switch",
    description: "Stands in for the owner changing the agent's mode. Use it in tests.",
    input: z.object({}),
    readOnly: true,
    capabilities: ["read"],
    run: async () => {
      await storage.agents.update(AGENT, { mode });
      return "ok";
    },
  });
}

/** A side-effecting tool whose own run changes the mode (the switch lands while it runs). */
function writeThenSwitch(storage: Storage, mode: AgentMode, executed: string[]): ToolDef {
  return defineTool({
    name: "first_write",
    description: "Writes something; meanwhile the owner changes the mode. Use it in tests.",
    input: z.object({}),
    readOnly: false,
    capabilities: ["internal.write"],
    run: async () => {
      executed.push("first_write");
      await storage.agents.update(AGENT, { mode });
      return "written";
    },
  });
}

async function round(calls: Array<{ name: string; input: unknown }>, extra: (storage: Storage, executed: string[]) => ToolDef[]) {
  const storage = await setup("autonomous");
  const tools = makeTools();
  const model = new FakeModelClient([toolUseMessage(calls), textMessage("Done.")]);
  const result = await runAgent(
    baseConfig([tools.set, { name: "owner", tools: extra(storage, tools.executed) }]),
    { userMessage: "save my notes" },
    { storage, model, sleep: noSleep },
  );
  return { storage, tools, model, result };
}

describe("invariant 5 (mid-round): a mode change during a tool round applies to the rest of that round", () => {
  it("off set by an earlier call of the round: the later side effect is denied, never executed, and audited", async () => {
    const { storage, tools, model, result } = await round(
      [
        { name: "owner_switch", input: {} },
        { name: "save_note", input: { text: "after off" } },
      ],
      (s) => [modeSwitch(s, "off")],
    );
    expect(result.toolCalls.map((c) => [c.name, c.decision])).toEqual([
      ["owner_switch", "allow"],
      ["save_note", "deny"],
    ]);
    expect(tools.executed).toEqual([]);
    const denials = await storage.audit.list({ action: "tool.deny" });
    expect(denials.map((a) => [a.target, a.details.reason])).toEqual([["save_note", "the agent was turned off during the run"]]);
    // The run then stops before its next model call.
    expect(result.end).toBe("aborted");
    expect(model.calls).toHaveLength(1);
    expect(await storage.proposals.list({ agentId: AGENT })).toEqual([]);
  });

  it("off set while a side effect runs: every later side effect of the round is denied", async () => {
    const { tools, result } = await round(
      [
        { name: "first_write", input: {} },
        { name: "save_note", input: { text: "one" } },
        { name: "save_note", input: { text: "two" } },
      ],
      (s, executed) => [writeThenSwitch(s, "off", executed)],
    );
    expect(result.toolCalls.map((c) => c.decision)).toEqual(["allow", "deny", "deny"]);
    expect(tools.executed).toEqual(["first_write"]);
  });

  it("shadow set during the round: the later side effect becomes a shadow draft, nothing runs", async () => {
    const { storage, tools, result } = await round(
      [
        { name: "owner_switch", input: {} },
        { name: "save_note", input: { text: "after shadow" } },
      ],
      (s) => [modeSwitch(s, "shadow")],
    );
    expect(result.toolCalls.map((c) => [c.name, c.decision])).toEqual([
      ["owner_switch", "allow"],
      ["save_note", "propose"],
    ]);
    expect(tools.executed).toEqual([]);
    const proposals = await storage.proposals.list({ agentId: AGENT });
    expect(proposals.map((p) => [p.kind, p.target, p.shadow])).toEqual([["action", "save_note", true]]);
    expect(result.proposals).toEqual([proposals[0]?.id]);
  });

  it("shadow set while a side effect runs: the next side effect of the round is a shadow draft", async () => {
    const { storage, tools, result } = await round(
      [
        { name: "first_write", input: {} },
        { name: "save_note", input: { text: "next" } },
      ],
      (s, executed) => [writeThenSwitch(s, "shadow", executed)],
    );
    expect(result.toolCalls.map((c) => c.decision)).toEqual(["allow", "propose"]);
    expect(tools.executed).toEqual(["first_write"]);
    expect((await storage.proposals.list({ agentId: AGENT })).map((p) => p.shadow)).toEqual([true]);
  });

  it("supervised set during the round: the later side effect is proposed (not a shadow draft), nothing runs", async () => {
    const { storage, tools, result } = await round(
      [
        { name: "owner_switch", input: {} },
        { name: "save_note", input: { text: "after supervised" } },
      ],
      (s) => [modeSwitch(s, "supervised")],
    );
    expect(result.toolCalls.map((c) => c.decision)).toEqual(["allow", "propose"]);
    expect(tools.executed).toEqual([]);
    expect((await storage.proposals.list({ agentId: AGENT })).map((p) => p.shadow)).toEqual([false]);
  });

  it("the memory tool after a switch to shadow gets the new mode: an add to an add-only store is a shadow draft", async () => {
    const storage = await setup("autonomous");
    const memory = new MemoryService({ storage });
    const skills = new SkillService({ storage });
    const proposals = new ProposalService({ storage, memory, skills });
    await memory.ensureStores(AGENT, [{ name: "user", capChars: 1375, autoApply: "add" }]);
    const model = new FakeModelClient([
      toolUseMessage([
        { name: "owner_switch", input: {} },
        { name: "memory", input: { store: "user", ops: [{ op: "add", text: "User likes tea." }] } },
      ]),
      textMessage("Noted."),
    ]);
    const result = await runAgent(
      baseConfig([knowledgeToolset({ memory, skills, proposals, storage }), { name: "owner", tools: [modeSwitch(storage, "shadow")] }]),
      { userMessage: "remember that I like tea" },
      { storage, model, sleep: noSleep, knowledge: knowledgeDeps({ memory, skills }) },
    );
    expect(result.end).toBe("end_turn");
    expect(await memory.entries(AGENT, "user")).toEqual([]);
    const listed = await storage.proposals.list({ agentId: AGENT });
    expect(listed.map((p) => [p.kind, p.status, p.shadow])).toEqual([["memory", "pending", true]]);
  });

  it("without a mode change the round runs as before (autonomous side effects run)", async () => {
    const { tools, result } = await round(
      [
        { name: "owner_switch", input: {} },
        { name: "save_note", input: { text: "still autonomous" } },
      ],
      (s) => [modeSwitch(s, "autonomous")],
    );
    expect(result.toolCalls.map((c) => c.decision)).toEqual(["allow", "allow"]);
    expect(tools.executed).toEqual(["save_note:still autonomous"]);
  });
});

describe("invariants, third hardening round (R3, R5, R7 loop half)", () => {
  it("off means off for parallel reads too: off set by an earlier call of the round denies every later read", async () => {
    const { storage, tools, result } = await round(
      [
        { name: "first_write", input: {} },
        { name: "read_a", input: { id: "1" } },
        { name: "read_b", input: { id: "2" } },
      ],
      (s, executed) => [writeThenSwitch(s, "off", executed)],
    );
    expect(result.toolCalls.map((c) => [c.name, c.decision])).toEqual([
      ["first_write", "allow"],
      ["read_a", "deny"],
      ["read_b", "deny"],
    ]);
    expect(tools.executed).toEqual(["first_write"]);
    const reasons = (await storage.audit.list({ action: "tool.deny" })).map((a) => a.details.reason);
    expect(reasons).toEqual(["the agent was turned off during the run", "the agent was turned off during the run"]);
  });

  it("an unattended continuation of an attended chat is recorded on the row and never cleared", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("Hi."), textMessage("Ok."), textMessage("Ok.")]);
    const deps = { storage, model, sleep: noSleep };
    const chat = await runAgent(baseConfig(), { userMessage: "hello" }, deps);
    expect((await storage.sessions.get(chat.sessionId))?.meta.unattendedRun).toBeUndefined();
    await runAgent(baseConfig(), { sessionId: chat.sessionId, attended: false, userMessage: "app text" }, deps);
    await runAgent(baseConfig(), { sessionId: chat.sessionId, attended: true, userMessage: "me again" }, deps);
    const row = await storage.sessions.get(chat.sessionId);
    expect(row?.meta.unattendedRun).toBe(true);
    expect(typeof row?.meta.unattendedRunAt).toBe("string");
  });

  it("two overlapping runs of one agent never record more than its monthly cap", async () => {
    const cap = 0.4;
    const storage = await setup("autonomous", { monthlyCostCapUsd: cap });
    let arrived = 0;
    let open: () => void = () => {};
    const both = new Promise<void>((resolve) => {
      open = resolve;
      setTimeout(resolve, 300);
    });
    const step = async (request: { maxTokens: number }) => {
      arrived += 1;
      if (arrived >= 2) open();
      await both;
      return textMessage("ok", { usage: { input: 1, output: request.maxTokens } });
    };
    const model = new FakeModelClient([step, step]);
    const run = () => runAgent(baseConfig(), { userMessage: "go" }, { storage, model, sleep: noSleep });
    await Promise.all([run(), run()]);
    expect(await storage.costs.sum({ agentId: AGENT, since: "2000-01-01T00:00:00.000Z" })).toBeLessThanOrEqual(cap);
  });
});
