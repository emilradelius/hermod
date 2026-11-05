import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  EFFORTS,
  MODELS,
  PRICING,
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  contextWindow,
  isEffort,
  isKnownModel,
  pricingFor,
  supportsServerFallback,
} from "../../../src/model/index.js";

const PROTOTYPE_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

describe("MODELS and DEFAULTS", () => {
  it("names the three current models by their exact ids", () => {
    expect(MODELS).toEqual({
      opus55: "claude-opus-5-5",
      sonnet55: "claude-sonnet-5-5",
      haiku55: "claude-haiku-5-5",
    });
  });

  it("routes main work to Opus 5.5 at medium effort and background work to Haiku 5.5 at low effort", () => {
    expect(DEFAULTS).toEqual({
      main: { model: "claude-opus-5-5", effort: "medium", maxTokens: 16_000 },
      background: { model: "claude-haiku-5-5", effort: "low", maxTokens: 4_000 },
    });
  });

  it("cannot be changed at runtime by a careless caller", () => {
    expect(() => {
      (DEFAULTS.main as { effort: string }).effort = "max";
    }).toThrow(TypeError);
    expect(() => {
      (MODELS as { opus55: string }).opus55 = "claude-opus-4-8";
    }).toThrow(TypeError);
    expect(DEFAULTS.main.effort).toBe("medium");
    expect(MODELS.opus55).toBe("claude-opus-5-5");
  });

  it("lists every effort level, lowest first, and recognises only those", () => {
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const effort of EFFORTS) expect(isEffort(effort)).toBe(true);
    for (const bad of ["MAX", "", "extreme", null, undefined, 3, ...PROTOTYPE_KEYS]) expect(isEffort(bad)).toBe(false);
  });
});

describe("PRICING", () => {
  it("has the published USD-per-MTok rates for Opus 5.5", () => {
    expect(PRICING["claude-opus-5-5"]?.rates).toEqual({
      input: 4,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
      output: 20,
    });
  });

  it("prices Sonnet 5.5 cache reads at $0.10 (0.05x input), not the $0.20 an older doc gave", () => {
    expect(PRICING["claude-sonnet-5-5"]?.rates).toEqual({
      input: 2,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
      cacheRead: 0.1,
      output: 10,
    });
  });

  it("has both Haiku 5.5 tiers with the 100,000-token threshold", () => {
    const haiku = PRICING["claude-haiku-5-5"];
    expect(haiku?.rates).toEqual({ input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 });
    expect(haiku?.longPrompt).toEqual({
      aboveTokens: 100_000,
      rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    });
  });

  it("prices the server-side fallback targets, so a fallback turn is never unpriced", () => {
    for (const model of ["claude-opus-5", "claude-opus-4-8"]) {
      expect(PRICING[model]?.rates).toEqual({ input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 });
    }
  });

  it("keeps the standard cache multipliers on every row (5m write 1.25x, 1h write 2x)", () => {
    for (const pricing of Object.values(PRICING)) {
      for (const rates of [pricing.rates, pricing.longPrompt?.rates].filter((r) => r !== undefined)) {
        expect(rates.cacheWrite5m).toBeCloseTo(rates.input * 1.25, 10);
        expect(rates.cacheWrite1h).toBeCloseTo(rates.input * 2, 10);
      }
    }
  });

  it("is frozen all the way down", () => {
    const opus = PRICING["claude-opus-5-5"];
    expect(() => {
      (opus?.rates as { input: number }).input = 0;
    }).toThrow(TypeError);
    expect(() => {
      (PRICING as Record<string, unknown>)["claude-free-1"] = { rates: {} };
    }).toThrow(TypeError);
    expect(PRICING["claude-opus-5-5"]?.rates.input).toBe(4);
  });

  it("pricingFor finds own entries only, never prototype members", () => {
    expect(pricingFor("claude-opus-5-5")).toBe(PRICING["claude-opus-5-5"]);
    for (const key of [...PROTOTYPE_KEYS, "", "claude-opus-5-5 ", "CLAUDE-OPUS-5-5"]) expect(pricingFor(key)).toBeUndefined();
    expect(pricingFor(42 as unknown as string)).toBeUndefined();
  });
});

describe("contextWindow and supportsServerFallback", () => {
  it("gives the 1M window for the current models and a conservative 200K for anything else", () => {
    for (const model of Object.values(MODELS)) expect(contextWindow(model)).toBe(1_000_000);
    expect(UNKNOWN_MODEL_CONTEXT_WINDOW).toBe(200_000);
    for (const model of ["claude-opus-4-8", "claude-haiku-4-5", "gpt-5", "", ...PROTOTYPE_KEYS]) {
      expect(contextWindow(model)).toBe(200_000);
    }
  });

  it("offers the server-side fallback on Opus 5.5 and Sonnet 5.5 but never on Haiku 5.5 or unknown models", () => {
    expect(supportsServerFallback(MODELS.opus55)).toBe(true);
    expect(supportsServerFallback(MODELS.sonnet55)).toBe(true);
    expect(supportsServerFallback(MODELS.haiku55)).toBe(false);
    for (const model of ["claude-opus-4-8", "claude-opus-5", "", ...PROTOTYPE_KEYS]) {
      expect(supportsServerFallback(model)).toBe(false);
    }
  });

  it("isKnownModel accepts exactly the ids in MODELS", () => {
    for (const model of Object.values(MODELS)) expect(isKnownModel(model)).toBe(true);
    for (const model of ["claude-opus-5", null, undefined, 1, ...PROTOTYPE_KEYS]) expect(isKnownModel(model)).toBe(false);
  });
});
