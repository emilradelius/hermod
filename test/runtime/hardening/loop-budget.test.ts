/**
 * Hardening (findings K, L): the USD caps bound output, not only the prompt, and the monthly cap is read fresh.
 * - K: before each call max_tokens is clamped so the worst case (estimateMaxCost) fits under what is left of the run
 *   cap and the monthly cap; below a small floor the run ends "budget_cost". The same holds for retries, the call
 *   after a fallback-model switch, the compression summary and a delegate child's calls.
 * - L: the month's spend is re-read before every call, so runs going on at the same time count each other's spend.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MIN_USEFUL_OUTPUT_TOKENS, availableUsd, clampMaxTokens, createBudget } from "../../../src/loop/budget.js";
import { estimateTokens, makeDelegateTool, runAgent } from "../../../src/loop/index.js";
import { estimateMaxCost } from "../../../src/model/cost.js";
import { apiError, FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { defineTool } from "../../../src/tools/define.js";
import type { Storage } from "../../../src/types.js";
import { AGENT, baseConfig, makeTools, noSleep, setup } from "../loop/helpers.js";

const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";

type Recorded = FakeModelClient["calls"][number];

/** The prompt size the loop estimates for a recorded request. */
function promptOf(call: Recorded | undefined): number {
  return estimateTokens({ system: call?.system, tools: call?.tools, messages: call?.messages });
}

function worstCase(call: Recorded | undefined): number {
  if (!call) throw new Error("no such call");
  return estimateMaxCost(call.model, promptOf(call), call.maxTokens);
}

function spendRecord(storage: Storage, usd: number, at: string) {
  return storage.costs.add({
    at,
    agentId: AGENT,
    sessionId: null,
    model: OPUS,
    purpose: "main",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usd,
  });
}

describe("K: clampMaxTokens", () => {
  it("returns the largest max_tokens whose worst case fits, never more than asked, null below the floor", () => {
    const prompt = 2_000;
    const base = estimateMaxCost(OPUS, prompt, 0);
    expect(clampMaxTokens(OPUS, prompt, 16_000, 100)).toBe(16_000);
    expect(clampMaxTokens(OPUS, prompt, 16_000, Infinity)).toBe(16_000);
    const room = base + 1_000 * 20e-6;
    const clamped = clampMaxTokens(OPUS, prompt, 16_000, room);
    expect(clamped).not.toBeNull();
    expect(estimateMaxCost(OPUS, prompt, clamped ?? 0)).toBeLessThanOrEqual(room);
    expect(estimateMaxCost(OPUS, prompt, (clamped ?? 0) + 1)).toBeGreaterThan(room);
    expect(clampMaxTokens(OPUS, prompt, 16_000, base + (MIN_USEFUL_OUTPUT_TOKENS - 1) * 20e-6)).toBeNull();
    expect(clampMaxTokens(OPUS, prompt, 16_000, base / 2)).toBeNull();
    expect(clampMaxTokens(OPUS, prompt, 16_000, 0)).toBeNull();
    // A configured max_tokens below the floor is itself the floor.
    expect(clampMaxTokens(OPUS, prompt, 50, base + 60 * 20e-6)).toBe(50);
  });
});

describe("K: one call can no longer spend many times the run cap", () => {
  it("the call's max_tokens is clamped so its worst case fits under the run cap", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok")]);
    const result = await runAgent(baseConfig([], { budget: { maxCostUsd: 0.02 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    const call = model.calls[0];
    expect(call?.maxTokens).toBeLessThan(16_000);
    expect(call?.maxTokens).toBeGreaterThanOrEqual(MIN_USEFUL_OUTPUT_TOKENS);
    expect(worstCase(call)).toBeLessThanOrEqual(0.02);
  });

  it("when the prompt fits but too few output tokens would, no call is made: budget_cost", async () => {
    // Learn the prompt's size from a roomy run, then give a cap that leaves room for the prompt and a few tokens.
    const probe = new FakeModelClient([textMessage("ok")]);
    await runAgent(baseConfig(), { userMessage: "go" }, { storage: await setup("autonomous"), model: probe, sleep: noSleep });
    const cap = estimateMaxCost(OPUS, promptOf(probe.calls[0]), 0) + 20 * 20e-6;

    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok")]);
    const result = await runAgent(baseConfig([], { budget: { maxCostUsd: cap } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("budget_cost");
    expect(model.calls).toHaveLength(0);
    expect(await storage.costs.list({ sessionId: result.sessionId })).toEqual([]);
  });

  it("the call after a fallback-model switch is fitted again, at the fallback model's prices", async () => {
    const storage = await setup("autonomous");
    const overloaded = () => ({ throw: apiError(529, "overloaded") });
    const model = new FakeModelClient([overloaded(), overloaded(), overloaded(), overloaded(), textMessage("ok", { model: OPUS })]);
    const cap = 0.05;
    const result = await runAgent(
      baseConfig([], { model: HAIKU, fallbackModel: OPUS, budget: { maxCostUsd: cap } }),
      { userMessage: "go" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    expect(model.calls.map((c) => c.model)).toEqual([HAIKU, HAIKU, HAIKU, HAIKU, OPUS]);
    // Haiku's worst case fits with the full max_tokens; Opus's does not.
    expect(model.calls[0]?.maxTokens).toBe(16_000);
    const fallback = model.calls[4];
    expect(fallback?.maxTokens).toBeLessThan(16_000);
    expect(worstCase(fallback)).toBeLessThanOrEqual(cap);
  });

  it("the compression summary call is clamped to what is left as well", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "read_a", input: { id: "1" } }], { model: HAIKU }),
      textMessage("## Goal\nnone\n## Constraints\nnone\n## Progress\nnone\n## Decisions\nnone\n## Files\nnone\n## Next steps\nnone"),
      textMessage("Done.", { model: HAIKU }),
    ]);
    const cap = 0.05;
    const result = await runAgent(
      baseConfig([tools.set], {
        model: HAIKU,
        budget: { maxCostUsd: cap },
        context: { windowTokens: 1_000, compressAtFraction: 0.5, tailTokens: 0, summaryModel: OPUS },
      }),
      { userMessage: "go" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    const summary = model.calls.find((c) => c.purpose === "summary");
    expect(summary?.model).toBe(OPUS);
    expect(summary?.maxTokens).toBeLessThan(4_000);
    const spentBefore = (await storage.costs.list({ sessionId: result.sessionId })).find((c) => c.purpose !== "summary")?.costUsd ?? 0;
    expect(worstCase(summary)).toBeLessThanOrEqual(cap - spentBefore + 1e-12);
  });

  it("a delegate child's calls are clamped to the child's slice", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      toolUseMessage([{ name: "delegate", input: { task: "look it up" } }]),
      textMessage("Child done."),
      textMessage("Parent done."),
    ]);
    const cap = 0.05;
    const result = await runAgent(
      baseConfig([tools.set, { name: "d", tools: [makeDelegateTool()] }], { budget: { maxCostUsd: cap } }),
      { userMessage: "go" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    const parentFirst = (await storage.costs.list({ sessionId: result.sessionId }))[0]?.costUsd ?? 0;
    const slice = (cap - parentFirst) * 0.5;
    const child = model.calls.find((c) => c.purpose === "delegate");
    expect(child?.maxTokens).toBeLessThan(16_000);
    expect(worstCase(child)).toBeLessThanOrEqual(slice + 1e-12);
    expect(result.costUsd).toBeLessThanOrEqual(cap);
  });
});

describe("L: the monthly cap is re-read before every call", () => {
  /** A read tool that stands in for another run of the same agent spending money at the same time. */
  function concurrentSpender(storage: Storage, usd: number) {
    return defineTool({
      name: "check_inbox",
      description: "Check the inbox. Use it to see what is new.",
      input: z.object({}),
      readOnly: true,
      capabilities: ["read"],
      run: async () => {
        await spendRecord(storage, usd, "2026-11-05T10:00:00.000Z");
        return "nothing new";
      },
    });
  }

  it("money another run spent meanwhile counts: the next call is not made when the month is used up", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 1 });
    const model = new FakeModelClient([toolUseMessage([{ name: "check_inbox", input: {} }]), textMessage("never sent")]);
    const result = await runAgent(
      baseConfig([{ name: "inbox", tools: [concurrentSpender(storage, 0.99)] }]),
      { userMessage: "go" },
      { storage, model, sleep: noSleep, now: () => new Date("2026-11-05T10:00:00.000Z") },
    );
    expect(result.end).toBe("budget_cost");
    expect(model.calls).toHaveLength(1);
  });

  it("the next call is clamped to the month's fresh remainder", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 1 });
    const model = new FakeModelClient([toolUseMessage([{ name: "check_inbox", input: {} }]), textMessage("ok")]);
    const result = await runAgent(
      baseConfig([{ name: "inbox", tools: [concurrentSpender(storage, 0.95)] }]),
      { userMessage: "go" },
      { storage, model, sleep: noSleep, now: () => new Date("2026-11-05T10:00:00.000Z") },
    );
    expect(result.end).toBe("end_turn");
    const spent = await storage.costs.sum({ agentId: AGENT, since: "2026-11-01T00:00:00.000Z" });
    expect(spent).toBeLessThanOrEqual(1);
    const second = model.calls[1];
    const left = 1 - 0.95 - ((await storage.costs.list({ sessionId: result.sessionId }))[0]?.costUsd ?? 0);
    expect(second?.maxTokens).toBeLessThan(16_000);
    expect(worstCase(second)).toBeLessThanOrEqual(left + 1e-12);
  });

  it("availableUsd reads the month's spend each time it is asked", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 2 });
    const now = new Date("2026-11-05T10:00:00.000Z");
    const agent = await storage.agents.get(AGENT);
    if (!agent) throw new Error("no agent");
    const budget = await createBudget(baseConfig([], { budget: { maxCostUsd: 5 } }), agent, storage, now);
    expect(await availableUsd(budget, storage, now, 0)).toBeCloseTo(2, 12);
    await spendRecord(storage, 1.5, "2026-11-04T00:00:00.000Z");
    expect(await availableUsd(budget, storage, now, 0)).toBeCloseTo(0.5, 12);
    expect(await availableUsd(budget, storage, now, 0.2)).toBeCloseTo(0.5, 12);
    await spendRecord(storage, 1, "2026-11-04T00:00:00.000Z");
    expect(await availableUsd(budget, storage, now, 0)).toBe(0);
  });
});
