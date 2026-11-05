import { describe, expect, it } from "vitest";
import { CostTracker, MODELS, costOf, estimateMaxCost, type CostUsage } from "../../../src/model/index.js";
import { fakeUsage } from "../../../src/testing/index.js";
import type { Usage } from "../../../src/types.js";

const M = 1_000_000;

/** A usage object with only the fields given (the rest absent, as costOf allows). */
function usage(fields: Partial<Usage> = {}): CostUsage {
  return { input_tokens: 0, output_tokens: 0, ...fields };
}

describe("costOf: each field at the published rate", () => {
  it("prices Opus 5.5 input, output, cache reads and both cache-write TTLs", () => {
    expect(costOf(MODELS.opus55, usage({ input_tokens: M }))).toBe(4);
    expect(costOf(MODELS.opus55, usage({ output_tokens: M }))).toBe(20);
    expect(costOf(MODELS.opus55, usage({ cache_read_input_tokens: M }))).toBe(0.2);
    // No TTL breakdown: all writes count as 5-minute writes.
    expect(costOf(MODELS.opus55, usage({ cache_creation_input_tokens: M }))).toBe(5);
    const oneHour = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M };
    expect(costOf(MODELS.opus55, usage({ cache_creation_input_tokens: M, cache_creation: oneHour }))).toBe(8);
  });

  it("splits cache writes by the TTL breakdown: 400K at $5 + 600K at $8 = $6.80", () => {
    const split = { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 };
    expect(costOf(MODELS.opus55, usage({ cache_creation_input_tokens: M, cache_creation: split }))).toBe(6.8);
  });

  it("prices Sonnet 5.5 cache reads at exactly $0.10 per MTok", () => {
    expect(costOf(MODELS.sonnet55, usage({ cache_read_input_tokens: M }))).toBe(0.1);
    expect(costOf(MODELS.sonnet55, usage({ input_tokens: M, output_tokens: M }))).toBe(12);
  });

  it("is exact, not merely close: one token of each kind on Opus 5.5 is $0.0000292", () => {
    // 4 (input) + 5 (5m write) + 0.2 (read) + 20 (output) = 29.2 USD per MTok.
    const one = usage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 });
    expect(costOf(MODELS.opus55, one)).toBe(0.0000292);
  });

  it("treats null cache fields as zero and accepts a full SDK usage object", () => {
    expect(costOf(MODELS.opus55, usage({ input_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: null }))).toBe(0.00004);
    // fakeUsage: 1,000 input + 100 output → 1,000 × $4 + 100 × $20 per MTok = $0.006.
    expect(costOf(MODELS.opus55, fakeUsage({ input: 1_000, output: 100 }))).toBe(0.006);
  });
});

describe("costOf: the Haiku 5.5 long-prompt tier", () => {
  // 40,000 input + 50,000 cache reads + 10,000 cache writes = 100,000 prompt tokens, plus 1,000 output tokens.
  const atThreshold = usage({
    input_tokens: 40_000,
    cache_read_input_tokens: 50_000,
    cache_creation_input_tokens: 10_000,
    output_tokens: 1_000,
  });

  it("keeps a prompt of exactly 100,000 tokens on the low tier", () => {
    // 40,000 × 0.10 + 50,000 × 0.01 + 10,000 × 0.125 + 1,000 × 0.50 = 6,250 µ$.
    expect(costOf(MODELS.haiku55, atThreshold)).toBe(0.00625);
  });

  it("moves 100,001 prompt tokens to the high tier for every token of the request, output included", () => {
    const over = { ...atThreshold, input_tokens: 40_001 };
    // 40,001 × 0.50 + 50,000 × 0.05 + 10,000 × 0.625 + 1,000 × 2.50 = 31,250.5 µ$.
    expect(costOf(MODELS.haiku55, over)).toBe(0.0312505);
  });

  it("counts cache reads and writes toward the threshold, not just input_tokens", () => {
    // 1 input + 100,000 cache reads = 100,001: 1 × 0.50 + 100,000 × 0.05 = 5,000.5 µ$.
    expect(costOf(MODELS.haiku55, usage({ input_tokens: 1, cache_read_input_tokens: 100_000 }))).toBe(0.0050005);
  });

  it("does not count output tokens toward the threshold", () => {
    // 100,000 input (low tier) + 50,000 output: 100,000 × 0.10 + 50,000 × 0.50 = 35,000 µ$.
    expect(costOf(MODELS.haiku55, usage({ input_tokens: 100_000, output_tokens: 50_000 }))).toBe(0.035);
  });
});

describe("costOf: modifiers", () => {
  const opus = usage({ input_tokens: M, output_tokens: M });

  it("halves every category for batch, explicitly or from usage.service_tier", () => {
    expect(costOf(MODELS.opus55, opus, { batch: true })).toBe(12);
    expect(costOf(MODELS.opus55, { ...opus, service_tier: "batch" })).toBe(12);
    // An explicit choice wins over the usage hint.
    expect(costOf(MODELS.opus55, { ...opus, service_tier: "batch" }, { batch: false })).toBe(24);
    expect(costOf(MODELS.opus55, { ...opus, service_tier: "standard" })).toBe(24);
  });

  it("adds 10% for US-only inference, stacking with batch and the Haiku high tier", () => {
    expect(costOf(MODELS.opus55, usage({ input_tokens: M }), { usOnly: true })).toBe(4.4);
    // 200,000 input on the high tier: 200,000 × 0.50 × 0.5 × 1.1 = 55,000 µ$.
    expect(costOf(MODELS.haiku55, usage({ input_tokens: 200_000 }), { batch: true, usOnly: true })).toBe(0.055);
  });

  it("doubles Opus prices in fast mode and refuses to guess for a model without fast mode", () => {
    expect(costOf(MODELS.opus55, { ...opus, speed: "fast" })).toBe(48);
    expect(costOf(MODELS.opus55, { ...opus, speed: "standard" })).toBe(24);
    expect(() => costOf(MODELS.haiku55, usage({ input_tokens: 1, speed: "fast" }))).toThrow(/no fast-mode price/);
  });
});

describe("costOf: usage.iterations (fallback hops, compaction)", () => {
  const refusedThenFallback = {
    // Top-level usage describes only the attempt that produced the message.
    ...usage({ input_tokens: 1_000, output_tokens: 200 }),
    iterations: [
      { type: "message", model: null, input_tokens: 1_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
    ],
  } as CostUsage;

  it("prices every billed attempt at its own model's rates instead of the top-level counts", () => {
    // Opus 5.5: 1,000 × 4 + 100 × 20 = 6,000 µ$. Opus 4.8: 1,000 × 5 + 200 × 25 = 10,000 µ$.
    expect(costOf(MODELS.opus55, refusedThenFallback)).toBe(0.016);
  });

  it("includes compaction entries, which the top-level counts leave out, at the requested model's rates", () => {
    const withCompaction = {
      ...usage({ input_tokens: 10, output_tokens: 10 }),
      iterations: [
        { type: "compaction", input_tokens: 50_000, output_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
        { type: "message", model: "claude-sonnet-5-5", input_tokens: 3_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      ],
    } as CostUsage;
    // 50,000 × 2 + 2,000 × 10 + 3,000 × 2 + 500 × 10 = 131,000 µ$.
    expect(costOf(MODELS.sonnet55, withCompaction)).toBe(0.131);
  });

  it("decides the Haiku tier for each attempt on its own", () => {
    const twoHops = {
      ...usage(),
      iterations: [60_000, 60_000].map((input) => ({
        type: "message",
        model: null,
        input_tokens: input,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
      })),
    } as CostUsage;
    // Each 60,000-token attempt is on the low tier: 2 × 60,000 × 0.10 = 12,000 µ$ (not 120,000 on the high tier).
    expect(costOf(MODELS.haiku55, twoHops)).toBe(0.012);
  });

  it("falls back to the top-level counts when iterations is empty or null", () => {
    expect(costOf(MODELS.opus55, { ...usage({ input_tokens: M }), iterations: [] })).toBe(4);
    expect(costOf(MODELS.opus55, { ...usage({ input_tokens: M }), iterations: null })).toBe(4);
  });

  it("throws, naming the model, when an attempt ran on a model with no price", () => {
    const unknownHop = {
      ...usage(),
      iterations: [{ type: "fallback_message", model: "claude-mystery-9", input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }],
    } as CostUsage;
    expect(() => costOf(MODELS.opus55, unknownHop)).toThrow(/"claude-mystery-9"/);
    const nullHop = { ...usage(), iterations: [null] } as unknown as CostUsage;
    expect(() => costOf(MODELS.opus55, nullHop)).toThrow(/usage\.iterations\[0\]/);
  });
});

describe("costOf: refuses to record a wrong number", () => {
  it("throws a clear error for an unknown model instead of recording 0", () => {
    expect(() => costOf("claude-free-1", usage({ input_tokens: 5 }))).toThrow(/No price is known for model "claude-free-1"/);
    for (const key of ["constructor", "__proto__", "toString", ""]) {
      expect(() => costOf(key, usage({ input_tokens: 5 }))).toThrow(/No price is known/);
    }
  });

  it("rejects negative, fractional, non-finite and non-number token counts", () => {
    const bad: unknown[] = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", 2 ** 60, {}];
    for (const value of bad) {
      expect(() => costOf(MODELS.opus55, usage({ input_tokens: value as number }))).toThrow(/usage\.input_tokens must be a whole number/);
      expect(() => costOf(MODELS.opus55, usage({ cache_read_input_tokens: value as number }))).toThrow(/cache_read_input_tokens/);
    }
    expect(() => costOf(MODELS.opus55, { input_tokens: 5 } as CostUsage)).toThrow(/usage\.output_tokens/);
    const badSplit = { ephemeral_5m_input_tokens: -5, ephemeral_1h_input_tokens: 0 };
    expect(() => costOf(MODELS.opus55, usage({ cache_creation_input_tokens: 5, cache_creation: badSplit }))).toThrow(/ephemeral_5m/);
  });

  it("rejects a usage value that is not an object", () => {
    for (const value of [null, undefined, 42, "usage"]) {
      expect(() => costOf(MODELS.opus55, value as unknown as CostUsage)).toThrow(TypeError);
    }
  });

  it("never under-counts when the TTL breakdown and the total disagree", () => {
    // Breakdown covers 500 of 1,000 writes: the other 500 count as 5m writes. 200 × 8 + 800 × 5 = 5,600 µ$.
    const partial = { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 };
    expect(costOf(MODELS.opus55, usage({ cache_creation_input_tokens: 1_000, cache_creation: partial }))).toBe(0.0056);
    // Breakdown larger than the total: the breakdown is priced. 300 × 5 + 200 × 8 = 3,100 µ$.
    expect(costOf(MODELS.opus55, usage({ cache_creation_input_tokens: 100, cache_creation: partial }))).toBe(0.0031);
  });
});

describe("estimateMaxCost", () => {
  it("assumes a cold cache (the whole prompt written at the 5m rate) and every output token", () => {
    // 100,000 × 5 + 16,000 × 20 = 820,000 µ$.
    expect(estimateMaxCost(MODELS.opus55, 100_000, 16_000)).toBe(0.82);
    expect(estimateMaxCost(MODELS.opus55, 100_000, 16_000, { batch: true })).toBe(0.41);
  });

  it("uses the Haiku tier the prompt size puts the request in", () => {
    // 100,000 × 0.125 + 4,000 × 0.5 = 14,500 µ$; 100,001 × 0.625 + 4,000 × 2.5 = 72,500.625 µ$.
    expect(estimateMaxCost(MODELS.haiku55, 100_000, 4_000)).toBe(0.0145);
    expect(estimateMaxCost(MODELS.haiku55, 100_001, 4_000)).toBe(0.072500625);
  });

  it("is never below the real cost of a call with that prompt size and at most that many output tokens", () => {
    let seed = 7;
    const next = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    for (let i = 0; i < 300; i += 1) {
      const model = [MODELS.opus55, MODELS.sonnet55, MODELS.haiku55][i % 3] ?? MODELS.opus55;
      const prompt = next(250_000);
      const read = next(prompt + 1);
      const write = next(prompt - read + 1);
      const maxOut = next(64_000) + 1;
      const real = usage({
        input_tokens: prompt - read - write,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        output_tokens: next(maxOut + 1),
      });
      expect(costOf(model, real)).toBeLessThanOrEqual(estimateMaxCost(model, prompt, maxOut));
    }
  });

  it("throws for an unknown model and for impossible token counts", () => {
    expect(() => estimateMaxCost("claude-free-1", 10, 10)).toThrow(/No price is known/);
    expect(() => estimateMaxCost(MODELS.opus55, -1, 10)).toThrow(/promptTokens/);
    expect(() => estimateMaxCost(MODELS.opus55, 10, Number.NaN)).toThrow(/maxOutputTokens/);
  });
});

describe("CostTracker", () => {
  const tenCents = usage({ cache_read_input_tokens: M }); // $0.10 on Sonnet 5.5

  it("adds calls up exactly (ten times $0.10 is $1, not 0.9999999999999999)", () => {
    const tracker = new CostTracker({ capUsd: 1 });
    let last = { usd: 0, totalUsd: 0 };
    for (let i = 0; i < 10; i += 1) last = tracker.add(MODELS.sonnet55, tenCents);
    expect(last).toEqual({ usd: 0.1, totalUsd: 1 });
    expect(tracker.totalUsd).toBe(1);
    expect(tracker.remainingUsd).toBe(0);
  });

  it("allows reaching the cap exactly but not going over it", () => {
    const tracker = new CostTracker({ capUsd: 1 });
    tracker.add(MODELS.sonnet55, tenCents);
    expect(tracker.remainingUsd).toBe(0.9);
    expect(tracker.wouldExceed(0.9)).toBe(false);
    expect(tracker.wouldExceed(0.900000000001)).toBe(true);
    expect(tracker.wouldExceed(estimateMaxCost(MODELS.opus55, 100_000, 16_000))).toBe(false);
    expect(tracker.wouldExceed(estimateMaxCost(MODELS.opus55, 150_000, 16_000))).toBe(true);
  });

  it("keeps recording past the cap, because the money is already spent", () => {
    const tracker = new CostTracker({ capUsd: 0.05 });
    expect(tracker.add(MODELS.sonnet55, tenCents)).toEqual({ usd: 0.1, totalUsd: 0.1 });
    expect(tracker.totalUsd).toBe(0.1);
    expect(tracker.remainingUsd).toBe(0);
    expect(tracker.wouldExceed(0)).toBe(true);
  });

  it("treats a cap of 0 as nothing allowed and Infinity as no cap", () => {
    const none = new CostTracker({ capUsd: 0 });
    expect(none.wouldExceed(0)).toBe(false);
    expect(none.wouldExceed(0.000001)).toBe(true);
    const unlimited = new CostTracker({ capUsd: Number.POSITIVE_INFINITY });
    unlimited.add(MODELS.opus55, usage({ output_tokens: 10 * M }));
    expect(unlimited.wouldExceed(1e9)).toBe(false);
    expect(unlimited.remainingUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it("applies its default pricing options, which a call can override", () => {
    const tracker = new CostTracker({ capUsd: 100, batch: true });
    expect(tracker.add(MODELS.opus55, usage({ input_tokens: M })).usd).toBe(2);
    expect(tracker.add(MODELS.opus55, usage({ input_tokens: M }), { batch: false }).usd).toBe(4);
    expect(tracker.totalUsd).toBe(6);
  });

  it("does not change the total when a call cannot be priced", () => {
    const tracker = new CostTracker({ capUsd: 1 });
    tracker.add(MODELS.sonnet55, tenCents);
    expect(() => tracker.add("claude-free-1", tenCents)).toThrow(/No price is known/);
    expect(tracker.totalUsd).toBe(0.1);
  });

  it("rejects a cap or an estimate that is not a non-negative number", () => {
    for (const cap of [-1, Number.NaN, "1", undefined]) {
      expect(() => new CostTracker({ capUsd: cap as number })).toThrow(/capUsd must be a number/);
    }
    const tracker = new CostTracker({ capUsd: 1 });
    for (const estimate of [-0.01, Number.NaN, "0.5"]) {
      expect(() => tracker.wouldExceed(estimate as number)).toThrow(/estimate must be a number/);
    }
    expect(tracker.wouldExceed(Number.POSITIVE_INFINITY)).toBe(true);
  });
});
