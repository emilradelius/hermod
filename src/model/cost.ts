/**
 * Usage → USD, and a per-run cost tracker with a hard cap.
 *
 * Money is computed in whole pico-dollars (1e-12 USD): every rate in PRICING is a whole number of pico-dollars per
 * token, so sums are exact and one final division gives the closest double to the true cost.
 *
 * Rules (Anthropic pricing page, 2026-11-05; facts sheet §4):
 * - Cache writes are split into 5-minute and 1-hour writes by `usage.cache_creation`; without it they count as 5m.
 * - Haiku 5.5: a request whose prompt (input + cache reads + cache writes) is over 100,000 tokens pays the higher
 *   rates for every token of that request.
 * - When `usage.iterations` is non-empty it is the billed record of every attempt (fallback hops, compaction,
 *   server-tool turns) and the top-level counts cover only the last attempt, so the entries are priced instead,
 *   each at its own model's rates.
 * - The result is an upper bound for refusals: a pre-output refusal (or a declined fallback hop) in an unbilled
 *   category (cyber, general_harms, none) still shows tokens in usage and is counted. Over-counting is the safe side
 *   for a budget cap.
 * - Batch is 50% off and US-only inference 1.1x, on every category; fast mode multiplies by the model's factor.
 * - An unknown model throws: a cost ledger must never silently record 0.
 */
import type { Usage } from "../types.js";
import { show } from "./internal.js";
import { pricingFor, type ModelPricing, type TokenRates } from "./models.js";

/** The usage fields costOf reads. A full SDK `BetaUsage` fits. */
export type CostUsage = Pick<Usage, "input_tokens" | "output_tokens"> &
  Partial<
    Pick<
      Usage,
      "cache_creation_input_tokens" | "cache_read_input_tokens" | "cache_creation" | "iterations" | "service_tier" | "speed"
    >
  >;

export interface CostOptions {
  /** Batch API prices (50% off). Default: true when `usage.service_tier` is "batch". */
  batch?: boolean;
  /** US-only inference (`inference_geo: "us"`, also via the workspace default): 1.1x. Default false. */
  usOnly?: boolean;
}

/** The token counts one billed attempt reports (top-level usage or one `usage.iterations` entry). */
interface UsageCounts {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

interface Counts {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

const PICO_PER_USD = 1e12;
const BATCH_FACTOR = 0.5;
const US_ONLY_FACTOR = 1.1;

/** The cost in USD of one model call's usage. `model` is the model the request named. */
export function costOf(model: string, usage: CostUsage, options: CostOptions = {}): number {
  return costPico(model, usage, options) / PICO_PER_USD;
}

/**
 * The most one call can cost, for a budget check before sending it: the whole prompt written to the cache (a cold
 * cache, 5-minute TTL as AnthropicModelClient sends) and every one of `maxOutputTokens` generated. One attempt only:
 * a refusal fallback hop is billed on top. Throws for an unknown model, so it fails before any money is spent.
 */
export function estimateMaxCost(
  model: string,
  promptTokens: number,
  maxOutputTokens: number,
  options: CostOptions = {},
): number {
  const pricing = requirePricing(model);
  const counts: Counts = {
    input: 0,
    write5m: tokenCount(promptTokens, "promptTokens"),
    write1h: 0,
    read: 0,
    output: tokenCount(maxOutputTokens, "maxOutputTokens"),
  };
  return priceCounts(pricing, counts, commonFactor(options, options.batch ?? false)) / PICO_PER_USD;
}

export interface CostTrackerOptions extends CostOptions {
  /** Hard cap for this run in USD. 0 allows nothing; Infinity means no cap. */
  capUsd: number;
}

/** Adds up the cost of one run's model calls and answers whether the next call fits under the cap. */
export class CostTracker {
  readonly capUsd: number;
  readonly #capPico: number;
  readonly #defaults: CostOptions;
  #spentPico = 0;

  constructor(options: CostTrackerOptions) {
    const { capUsd, ...defaults } = options;
    if (typeof capUsd !== "number" || Number.isNaN(capUsd) || capUsd < 0) {
      throw new RangeError(`CostTracker: capUsd must be a number of US dollars, 0 or more (got ${show(capUsd)}).`);
    }
    this.capUsd = capUsd;
    this.#capPico = usdToPico(capUsd);
    this.#defaults = defaults;
  }

  /** Records one call. Always records, even past the cap: the money is already spent. */
  add(model: string, usage: CostUsage, options?: CostOptions): { usd: number; totalUsd: number } {
    const pico = costPico(model, usage, { ...this.#defaults, ...options });
    this.#spentPico += pico;
    return { usd: pico / PICO_PER_USD, totalUsd: this.totalUsd };
  }

  get totalUsd(): number {
    return this.#spentPico / PICO_PER_USD;
  }

  /** What is left under the cap, never below 0. */
  get remainingUsd(): number {
    return Math.max(0, this.#capPico - this.#spentPico) / PICO_PER_USD;
  }

  /** True when spending `estimateUsd` more would go over the cap (reaching it exactly is allowed). */
  wouldExceed(estimateUsd: number): boolean {
    if (typeof estimateUsd !== "number" || Number.isNaN(estimateUsd) || estimateUsd < 0) {
      throw new RangeError(`CostTracker: the estimate must be a number of US dollars, 0 or more (got ${show(estimateUsd)}).`);
    }
    return this.#spentPico + usdToPico(estimateUsd) > this.#capPico;
  }
}

function costPico(model: string, usage: CostUsage, options: CostOptions): number {
  requireObject(usage, "usage");
  const factor = commonFactor(options, options.batch ?? (usage.service_tier === "batch"));
  const fast = usage.speed === "fast";
  const iterations = usage.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    return iterations.reduce((sum, entry, index) => {
      const where = `usage.iterations[${index}]`;
      return sum + pricePart(iterationModel(entry, model, where), entry, where, factor, fast);
    }, 0);
  }
  return pricePart(model, usage, "usage", factor, fast);
}

/** Fallback and advisor entries name the model that ran; message entries may (null means the requested model). */
function iterationModel(entry: unknown, requested: string, where: string): string {
  requireObject(entry, where);
  const named = (entry as { model?: unknown }).model;
  return typeof named === "string" && named !== "" ? named : requested;
}

function pricePart(model: string, usage: UsageCounts, where: string, factor: number, fast: boolean): number {
  const pricing = requirePricing(model);
  return priceCounts(pricing, countsOf(usage, where), factor * (fast ? fastFactor(model, pricing) : 1));
}

function priceCounts(pricing: ModelPricing, counts: Counts, factor: number): number {
  const rates = ratesFor(pricing, counts.input + counts.read + counts.write5m + counts.write1h);
  return (
    counts.input * picoPerToken(rates.input, factor) +
    counts.write5m * picoPerToken(rates.cacheWrite5m, factor) +
    counts.write1h * picoPerToken(rates.cacheWrite1h, factor) +
    counts.read * picoPerToken(rates.cacheRead, factor) +
    counts.output * picoPerToken(rates.output, factor)
  );
}

/** Haiku 5.5's long-prompt tier applies only above the threshold: exactly 100,000 tokens is the low tier. */
function ratesFor(pricing: ModelPricing, promptTokens: number): TokenRates {
  const long = pricing.longPrompt;
  return long && promptTokens > long.aboveTokens ? long.rates : pricing.rates;
}

/** USD per MTok → whole pico-dollars per token (1 USD/MTok = 1e6 pico-dollars per token). */
function picoPerToken(usdPerMTok: number, factor: number): number {
  return Math.round(usdPerMTok * 1e6 * factor);
}

function commonFactor(options: CostOptions, batch: boolean): number {
  return (batch ? BATCH_FACTOR : 1) * (options.usOnly ? US_ONLY_FACTOR : 1);
}

function fastFactor(model: string, pricing: ModelPricing): number {
  if (pricing.fastModeMultiplier === undefined) {
    throw new Error(`costOf: the usage says fast mode, but model "${model}" has no fast-mode price.`);
  }
  return pricing.fastModeMultiplier;
}

function requirePricing(model: string): ModelPricing {
  const pricing = pricingFor(model);
  if (!pricing) {
    throw new Error(
      `No price is known for model ${show(model)}, so its cost cannot be recorded. ` +
        "Add the model to PRICING in src/model/models.ts (a cost ledger must never record 0).",
    );
  }
  return pricing;
}

function countsOf(usage: UsageCounts, where: string): Counts {
  const { write5m, write1h } = cacheWrites(usage, where);
  return {
    input: tokenCount(usage.input_tokens, `${where}.input_tokens`),
    output: tokenCount(usage.output_tokens, `${where}.output_tokens`),
    read: tokenCount(usage.cache_read_input_tokens ?? 0, `${where}.cache_read_input_tokens`),
    write5m,
    write1h,
  };
}

/**
 * Splits cache writes by TTL. If the breakdown and the total disagree, the larger reading wins (the remainder counts
 * as 5m writes): the ledger may over-count a malformed usage object, never under-count it.
 */
function cacheWrites(usage: UsageCounts, where: string): { write5m: number; write1h: number } {
  const total = tokenCount(usage.cache_creation_input_tokens ?? 0, `${where}.cache_creation_input_tokens`);
  const split = usage.cache_creation;
  if (split === null || split === undefined) return { write5m: total, write1h: 0 };
  const write1h = tokenCount(split.ephemeral_1h_input_tokens, `${where}.cache_creation.ephemeral_1h_input_tokens`);
  const write5m = tokenCount(split.ephemeral_5m_input_tokens, `${where}.cache_creation.ephemeral_5m_input_tokens`);
  return { write5m: Math.max(write5m, total - write1h), write1h };
}

function requireObject(value: unknown, where: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`costOf: ${where} must be a usage object from a model response (got ${show(value)}).`);
  }
}

function tokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a whole number of tokens, 0 or more (got ${show(value)}).`);
  }
  return value;
}

function usdToPico(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * PICO_PER_USD) : usd;
}
