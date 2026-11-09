/**
 * Hardening, third round, LOOP block: the cost clamp's worst case.
 * - R1: the prompt size is conservative (non-ASCII text, the last real prompt size) and Haiku 5.5's long-prompt tier
 *   is priced whenever the prompt could pass its threshold.
 * - R2: a request with the server-side refusal fallback keeps it only when two full attempts fit; otherwise it is
 *   sent with refusalFallback: false and clamped for one attempt.
 * - R3: overlapping runs of one agent reserve each call's worst case against the monthly cap (per process).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LONG_PROMPT_MARGIN, clampMaxTokens, promptSize, reservedUsd } from "../../../src/loop/budget.js";
import { estimatePromptTokens, estimateTokens, runAgent } from "../../../src/loop/index.js";
import { buildStreamParams } from "../../../src/model/client.js";
import { estimateBudgetCost, estimateMaxCost } from "../../../src/model/cost.js";
import { apiError, FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import { defineTool } from "../../../src/tools/define.js";
import type { Message, ModelRequest } from "../../../src/types.js";
import { AGENT, baseConfig, makeTools, noSleep, setup } from "../loop/helpers.js";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

type Recorded = FakeModelClient["calls"][number];

function promptOf(call: Recorded | undefined): number {
  return estimatePromptTokens({ system: call?.system, tools: call?.tools, messages: call?.messages });
}

describe("R1: a conservative prompt size", () => {
  it("estimatePromptTokens counts non-ASCII text at one token per code point or more; ASCII as estimateTokens", () => {
    const ascii = "plain words ".repeat(1_000);
    expect(estimatePromptTokens(ascii)).toBe(estimateTokens(ascii));
    const cjk = "字".repeat(10_000);
    expect(estimateTokens(cjk)).toBeLessThan(3_000);
    expect(estimatePromptTokens(cjk)).toBeGreaterThanOrEqual(10_000);
    expect(estimatePromptTokens("é".repeat(1_000))).toBeGreaterThanOrEqual(1_000);
    expect(estimatePromptTokens("😀".repeat(1_000))).toBeGreaterThanOrEqual(1_000);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimatePromptTokens(circular)).toBe(Infinity);
  });

  it("promptSize: the known real size plus the added estimate is a floor; the tier bound has the margin", () => {
    expect(promptSize(1_000)).toEqual({ tokens: 1_000, tierTokens: 1_000 * LONG_PROMPT_MARGIN });
    expect(promptSize(1_000, { tokens: 150_000, addedEstimate: 100 })).toEqual({
      tokens: 150_100,
      tierTokens: 150_000 + 100 * LONG_PROMPT_MARGIN,
    });
    expect(promptSize(Number.NaN).tokens).toBe(Infinity);
  });

  it("estimateBudgetCost prices the long tier when the tier bound is over the threshold", () => {
    const low = estimateMaxCost(HAIKU, 60_000, 1_000);
    expect(estimateBudgetCost(HAIKU, 60_000, 1_000)).toBe(low);
    expect(estimateBudgetCost(HAIKU, 60_000, 1_000, { tierPromptTokens: 120_000 })).toBeCloseTo(60_000 * 0.625e-6 + 1_000 * 2.5e-6, 12);
    expect(estimateBudgetCost(HAIKU, 60_000, 1_000, { tierPromptTokens: Number.NaN })).toBeGreaterThan(low);
    // A clamp with a non-finite prompt size refuses the call (it used to count it as 0).
    expect(clampMaxTokens(HAIKU, Infinity, 16_000, 100)).toBeNull();
  });

  it("the repro: 120,000 CJK characters on Haiku with maxCostUsd 0.02 make no call at all", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([
      textMessage("ok", { model: HAIKU, usage: { input: 130_000, output: 16_000 } }),
    ]);
    const result = await runAgent(
      baseConfig([], { model: HAIKU, budget: { maxCostUsd: 0.02 } }),
      { userMessage: "字".repeat(120_000) },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("budget_cost");
    expect(model.calls).toHaveLength(0);
    expect(result.costUsd).toBe(0);
  });

  it("an ASCII prompt that could pass the threshold is clamped at the long-prompt rates", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok", { model: HAIKU })]);
    // About 60,000 estimated tokens: under the threshold as estimated, over it with the margin.
    const cap = 0.06;
    const result = await runAgent(
      baseConfig([], { model: HAIKU, budget: { maxCostUsd: cap } }),
      { userMessage: "abcd".repeat(60_000) },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    const call = model.calls[0];
    const prompt = promptOf(call);
    expect(prompt).toBeLessThan(100_000);
    expect(prompt * LONG_PROMPT_MARGIN).toBeGreaterThan(100_000);
    // At the low rates the full 16,000 tokens would fit; at the long rates they do not.
    expect(estimateMaxCost(HAIKU, prompt, 16_000)).toBeLessThan(cap);
    expect(call?.maxTokens).toBeLessThan(16_000);
    expect(estimateBudgetCost(HAIKU, prompt, call?.maxTokens ?? 0, { tierPromptTokens: 100_001 })).toBeLessThanOrEqual(cap);
  });

  it("from the second call on, the real prompt size the API reported is a floor (and picks the tier)", async () => {
    const storage = await setup("autonomous");
    const tools = makeTools();
    const model = new FakeModelClient([
      // The API says the first prompt was 150,000 tokens, far more than the estimate of the short text.
      toolUseMessage([{ name: "read_a", input: { id: "1" } }], { model: HAIKU, usage: { input: 150_000, output: 100 } }),
      textMessage("Done.", { model: HAIKU }),
    ]);
    const cap = 0.2;
    const result = await runAgent(
      // A window large enough that 150,000 tokens do not start a compression.
      baseConfig([tools.set], { model: HAIKU, budget: { maxCostUsd: cap }, context: { windowTokens: 1_000_000 } }),
      { userMessage: "look it up" },
      { storage, model, sleep: noSleep },
    );
    expect(result.end).toBe("end_turn");
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.maxTokens).toBe(16_000);
    const second = model.calls[1];
    // The estimate alone would have allowed the full 16,000 tokens at the low rates.
    expect(estimateMaxCost(HAIKU, promptOf(second), 16_000)).toBeLessThan(cap - result.costUsd);
    expect(second?.maxTokens).toBeLessThan(16_000);
    const spentBefore = (await storage.costs.list({ sessionId: result.sessionId }))[1]?.costUsd ?? 0;
    expect(spentBefore).toBeGreaterThan(0);
    const firstCost = result.costUsd - spentBefore;
    expect(estimateMaxCost(HAIKU, 150_000, second?.maxTokens ?? 0)).toBeLessThanOrEqual(cap - firstCost);
  });
});

describe("R2: the refusal fallback hop is inside the clamped worst case", () => {
  it("estimateBudgetCost with fallbackHop adds an attempt at the most expensive fallback target", () => {
    const one = estimateMaxCost(OPUS, 10_000, 2_000);
    const hop = estimateMaxCost("claude-opus-5", 10_000, 2_000);
    expect(estimateBudgetCost(OPUS, 10_000, 2_000, { fallbackHop: true })).toBeCloseTo(one + hop, 12);
    expect(estimateBudgetCost(SONNET, 10_000, 2_000, { fallbackHop: true })).toBeGreaterThanOrEqual(
      estimateMaxCost(SONNET, 10_000, 2_000) + hop,
    );
  });

  it("when two attempts do not fit, the request is sent with refusalFallback: false (no fallbacks param)", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok")]);
    const cap = 0.5;
    const result = await runAgent(baseConfig([], { budget: { maxCostUsd: cap } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    const call = model.calls[0] as Recorded;
    expect(estimateBudgetCost(OPUS, promptOf(call), 16_000, { fallbackHop: true })).toBeGreaterThan(cap);
    expect(call.refusalFallback).toBe(false);
    expect(call.maxTokens).toBe(16_000);
    expect(estimateMaxCost(OPUS, promptOf(call), call.maxTokens)).toBeLessThanOrEqual(cap);
    const params = buildStreamParams(call as ModelRequest);
    expect(params.fallbacks).toBeUndefined();
  });

  it("when two full attempts fit, the fallback stays on and both fit under the cap", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok")]);
    const cap = 2;
    await runAgent(baseConfig([], { budget: { maxCostUsd: cap } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    const call = model.calls[0] as Recorded;
    expect(call.refusalFallback).toBeUndefined();
    expect(call.maxTokens).toBe(16_000);
    expect(estimateBudgetCost(OPUS, promptOf(call), call.maxTokens, { fallbackHop: true })).toBeLessThanOrEqual(cap);
    expect(buildStreamParams(call as ModelRequest).fallbacks).toBe("default");
  });

  it("a Haiku request never gets a refusalFallback field (it has no server-side fallback)", async () => {
    const storage = await setup("autonomous");
    const model = new FakeModelClient([textMessage("ok", { model: HAIKU })]);
    await runAgent(baseConfig([], { model: HAIKU, budget: { maxCostUsd: 0.01 } }), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(model.calls[0]).not.toHaveProperty("refusalFallback");
  });
});

/** A fake step that waits until `count` calls have arrived (or 300 ms passed), then answers at its full max_tokens. */
function overlapping(count: number): (request: ModelRequest) => Promise<Message> {
  let arrived = 0;
  let open: () => void = () => {};
  const all = new Promise<void>((resolve) => {
    open = resolve;
    setTimeout(resolve, 300);
  });
  return async (request) => {
    arrived += 1;
    if (arrived >= count) open();
    await all;
    return textMessage("ok", { usage: { input: 0, cacheWrite: estimatePromptTokens({ system: request.system, tools: request.tools, messages: request.messages }), output: request.maxTokens } });
  };
}

describe("R3: overlapping runs of one agent cannot each spend the whole monthly remainder", () => {
  it("two runs in parallel: the second call is clamped by the first one's reservation; the month stays under its cap", async () => {
    const cap = 0.5;
    const storage = await setup("autonomous", { monthlyCostCapUsd: cap });
    const step = overlapping(2);
    const model = new FakeModelClient([step, step]);
    const run = () => runAgent(baseConfig(), { userMessage: "go" }, { storage, model, sleep: noSleep });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.end, b.end]).toEqual(["end_turn", "end_turn"]);
    expect(model.calls).toHaveLength(2);
    const spent = await storage.costs.sum({ agentId: AGENT, since: "2000-01-01T00:00:00.000Z" });
    expect(spent).toBeLessThanOrEqual(cap);
    // Without the reservation both calls would have seen the whole remainder and asked for 16,000 tokens each.
    expect(model.calls.map((c) => c.maxTokens).sort((x, y) => x - y)[0]).toBeLessThan(16_000);
    expect(reservedUsd(storage, AGENT)).toBe(0);
  });

  it("a reservation is released when the call fails, and when the run ends", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 5 });
    const failing = new FakeModelClient([{ throw: apiError(400, "bad request") }]);
    const failed = await runAgent(baseConfig(), { userMessage: "go" }, { storage, model: failing, sleep: noSleep });
    expect(failed.end).toBe("error");
    expect(reservedUsd(storage, AGENT)).toBe(0);

    // Between retries (the backoff sleep) a failed attempt holds no reservation.
    const seenInSleep: number[] = [];
    const retried = new FakeModelClient([{ throw: apiError(529, "overloaded") }, textMessage("ok")]);
    const sleep = async (): Promise<void> => {
      seenInSleep.push(reservedUsd(storage, AGENT));
    };
    expect((await runAgent(baseConfig(), { userMessage: "go" }, { storage, model: retried, sleep })).end).toBe("end_turn");
    expect(seenInSleep).toEqual([0]);

    let during = 0;
    const model = new FakeModelClient([
      (request: ModelRequest) => {
        during = reservedUsd(storage, AGENT);
        return textMessage("ok", { usage: { input: 10, output: Math.min(100, request.maxTokens) } });
      },
    ]);
    const ok = await runAgent(baseConfig(), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(ok.end).toBe("end_turn");
    expect(during).toBeGreaterThan(0);
    expect(reservedUsd(storage, AGENT)).toBe(0);
  });

  it("the reservation ends once the call's cost is recorded: a tool round after the call holds none", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 5 });
    let duringTool = -1;
    const probe = defineTool({
      name: "probe",
      description: "Looks at the open reservations. Use it in tests.",
      input: z.object({}),
      readOnly: true,
      capabilities: ["read"],
      run: () => {
        duringTool = reservedUsd(storage, AGENT);
        return "ok";
      },
    });
    const model = new FakeModelClient([toolUseMessage([{ name: "probe", input: {} }]), textMessage("Done.")]);
    const result = await runAgent(baseConfig([{ name: "p", tools: [probe] }]), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    expect(duringTool).toBe(0);
  });

  it("reservations are per storage object: another storage does not see them", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 5 });
    const other = await setup("autonomous", { monthlyCostCapUsd: 5 });
    let seenOther = -1;
    const model = new FakeModelClient([
      () => {
        seenOther = reservedUsd(other, AGENT);
        return textMessage("ok");
      },
    ]);
    await runAgent(baseConfig(), { userMessage: "go" }, { storage, model, sleep: noSleep });
    expect(seenOther).toBe(0);
  });
});
