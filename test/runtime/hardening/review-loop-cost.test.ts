/**
 * Review fix C2 (LOOP block): a paid call never vanishes from the monthly cap.
 * - A usage.iterations entry for a model PRICING does not list (a refusal-fallback hop answered by an unpriced model)
 *   is charged at the highest rates of any priced model; the cost row is written, an audit entry names the model,
 *   and the run goes on.
 * - Usage that cannot be priced at all is charged the worst case reserved for the call, and the run ends "error".
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../../src/loop/index.js";
import { conservativeCostOf, costOf, CostTracker } from "../../../src/model/cost.js";
import { PRICING } from "../../../src/model/models.js";
import { FakeModelClient, textMessage } from "../../../src/testing/index.js";
import type { Message } from "../../../src/types.js";
import { AGENT, baseConfig, noSleep, setup } from "../loop/helpers.js";

const SONNET = "claude-sonnet-5-5";
const UNPRICED = "claude-unpriced-test-model";

/** The highest rate (USD per MTok) of any priced model, either tier, for one category. */
function highest(key: "input" | "output" | "cacheWrite5m" | "cacheRead"): number {
  let max = 0;
  for (const pricing of Object.values(PRICING)) {
    max = Math.max(max, pricing.rates[key], pricing.longPrompt?.rates[key] ?? 0);
  }
  return max;
}

function withUnpricedFallbackHop(): Message {
  const message = textMessage("ok", { model: SONNET, usage: { input: 50_000, output: 8_000 } });
  message.usage.iterations = [
    { type: "message", model: null, input_tokens: 50_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: "fallback", model: UNPRICED, input_tokens: 50_000, output_tokens: 8_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ] as unknown as Message["usage"]["iterations"];
  return message;
}

describe("C2: an unpriced model in usage.iterations is charged conservatively", () => {
  it("conservativeCostOf prices known entries exactly and the unknown one at the highest rates, and names it", () => {
    const usage = withUnpricedFallbackHop().usage;
    expect(() => costOf(SONNET, usage)).toThrow(/No price is known/);
    const result = conservativeCostOf(SONNET, usage);
    const known = (50_000 * PRICING[SONNET]!.rates.input + 10 * PRICING[SONNET]!.rates.output) / 1e6;
    const unknown = (50_000 * highest("input") + 8_000 * highest("output")) / 1e6;
    expect(result.unknownModels).toEqual([UNPRICED]);
    expect(result.usd).toBeCloseTo(known + unknown, 12);
    // Never below what the hop would cost at the requested model's own rates.
    expect(result.usd).toBeGreaterThanOrEqual(
      (50_000 * PRICING[SONNET]!.rates.input * 2 + (10 + 8_000) * PRICING[SONNET]!.rates.output) / 1e6,
    );
    // A fully priced usage gives the same number as costOf and no unknown model.
    const plain = textMessage("ok", { model: SONNET }).usage;
    expect(conservativeCostOf(SONNET, plain)).toEqual({ usd: costOf(SONNET, plain), unknownModels: [] });
  });

  it("CostTracker.addConservative and addUsd count against the cap", () => {
    const tracker = new CostTracker({ capUsd: 1 });
    const added = tracker.addConservative(SONNET, withUnpricedFallbackHop().usage);
    expect(added.unknownModels).toEqual([UNPRICED]);
    expect(tracker.totalUsd).toBeCloseTo(added.usd, 12);
    tracker.addUsd(0.25);
    expect(tracker.totalUsd).toBeCloseTo(added.usd + 0.25, 12);
    expect(() => tracker.addUsd(Number.NaN)).toThrow(RangeError);
    expect(() => tracker.addUsd(-1)).toThrow(RangeError);
  });

  it("runAgent writes the cost row (never nothing), audits the unpriced model, and the run goes on", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 5 });
    const model = new FakeModelClient([withUnpricedFallbackHop()]);
    const result = await runAgent(baseConfig([], { model: SONNET }), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("end_turn");
    expect(result.text).toBe("ok");
    const expected = conservativeCostOf(SONNET, withUnpricedFallbackHop().usage).usd;
    const rows = await storage.costs.list({ agentId: AGENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBeCloseTo(expected, 12);
    expect(rows[0]?.costUsd).toBeGreaterThan(0.5);
    expect(result.costUsd).toBeCloseTo(expected, 12);
    expect(await storage.costs.sum({ agentId: AGENT, since: "2026-11-01T00:00:00.000Z" })).toBeCloseTo(expected, 12);
    const notes = await storage.audit.list({ action: "cost.unpriced_model" });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.details.models).toEqual([UNPRICED]);
    expect(String(notes[0]?.details.note)).toContain(UNPRICED);
    expect(notes[0]?.details.sessionId).toBe(result.sessionId);
  });

  it("usage that cannot be priced at all is charged the call's reserved worst case, and the run ends 'error'", async () => {
    const storage = await setup("autonomous", { monthlyCostCapUsd: 5 });
    const broken = textMessage("ok", { model: SONNET });
    (broken.usage as { output_tokens: unknown }).output_tokens = -1;
    const model = new FakeModelClient([broken]);
    const result = await runAgent(baseConfig([], { model: SONNET }), { userMessage: "hi" }, { storage, model, sleep: noSleep });
    expect(result.end).toBe("error");
    const rows = await storage.costs.list({ agentId: AGENT });
    expect(rows).toHaveLength(1);
    // The reserved worst case covers every max_tokens output token: far above any real cost of a short call.
    const maxTokens = model.calls[0]?.maxTokens ?? 0;
    expect(maxTokens).toBeGreaterThan(0);
    expect(rows[0]?.costUsd).toBeGreaterThanOrEqual((maxTokens * PRICING[SONNET]!.rates.output) / 1e6);
    expect(rows[0]?.outputTokens).toBe(0);
    expect(result.costUsd).toBeCloseTo(rows[0]?.costUsd ?? -1, 12);
    expect(await storage.audit.list({ action: "cost.uncomputable" })).toHaveLength(1);
    expect(result.errors.at(-1)?.message).toMatch(/reserved worst case/);
  });
});
