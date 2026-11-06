/**
 * Model ids, per-route defaults, prices and limits for the models Hermod calls.
 *
 * Prices are USD per million tokens (MTok), from the Anthropic pricing page as read on 2026-11-05 (the same figures
 * as the SDK facts sheet, §4). Sonnet 5.5 cache reads are $0.10 (0.05x input), not the $0.20 an older doc gave.
 */
import type { Effort } from "../types.js";

export const MODELS = Object.freeze({
  opus55: "claude-opus-5-5",
  sonnet55: "claude-sonnet-5-5",
  haiku55: "claude-haiku-5-5",
} as const);

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** One order for every effort level the API accepts (a missing level is a type error here). */
const EFFORT_ORDER: Readonly<Record<Effort, number>> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/** Every effort level, lowest first. */
export const EFFORTS: readonly Effort[] = Object.freeze(Object.keys(EFFORT_ORDER) as Effort[]);

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && Object.hasOwn(EFFORT_ORDER, value);
}

export interface RouteDefaults {
  readonly model: ModelId;
  /** Always sent explicitly: Opus 5.5 and Haiku 5.5 default to "medium", Sonnet 5.5 to "high". */
  readonly effort: Effort;
  readonly maxTokens: number;
}

/** main: the agent's own turns. background: reviews, summaries and other cheap side work. */
export const DEFAULTS: { readonly main: RouteDefaults; readonly background: RouteDefaults } = deepFreeze({
  main: { model: MODELS.opus55, effort: "medium", maxTokens: 16_000 },
  background: { model: MODELS.haiku55, effort: "low", maxTokens: 4_000 },
});

/** USD per million tokens. */
export interface TokenRates {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface ModelPricing {
  /** The rates for every request, or for prompts up to `longPrompt.aboveTokens` when the model has that tier. */
  readonly rates: TokenRates;
  /** Haiku 5.5: a request whose prompt (input + cache reads + cache writes) is over `aboveTokens` pays these rates. */
  readonly longPrompt?: { readonly aboveTokens: number; readonly rates: TokenRates };
  /** Fast mode multiplies every rate by this. Absent: the model has no fast mode. */
  readonly fastModeMultiplier?: number;
}

/**
 * Prices by model id. `claude-opus-5` and `claude-opus-4-8` are here because they are the targets of Opus 5.5's
 * server-side refusal fallback: a fallback turn is billed at the fallback model's rates (see `usage.iterations`).
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = deepFreeze({
  [MODELS.opus55]: {
    rates: { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
    fastModeMultiplier: 2,
  },
  [MODELS.sonnet55]: {
    rates: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  },
  [MODELS.haiku55]: {
    rates: { input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 },
    longPrompt: {
      aboveTokens: 100_000,
      rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    },
  },
  "claude-opus-5": {
    rates: { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    fastModeMultiplier: 2,
  },
  "claude-opus-4-8": {
    rates: { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    fastModeMultiplier: 2,
  },
});

/** The price entry for a model id, or undefined. Own keys only, so "constructor" or "__proto__" never match. */
export function pricingFor(model: string): ModelPricing | undefined {
  return typeof model === "string" && Object.hasOwn(PRICING, model) ? PRICING[model] : undefined;
}

interface ModelInfo {
  readonly contextWindow: number;
  /** Accepts `fallbacks: "default"` (server-side refusal fallback, beta server-side-fallback-2026-07-01). */
  readonly serverFallback: boolean;
}

const MODEL_INFO: Readonly<Record<ModelId, ModelInfo>> = deepFreeze({
  [MODELS.opus55]: { contextWindow: 1_000_000, serverFallback: true },
  // The refusals docs and the claude-api skill list Sonnet 5.5 for the "default" form on the Claude API.
  [MODELS.sonnet55]: { contextWindow: 1_000_000, serverFallback: true },
  // Haiku 5.5 has no server-side fallback: a declined request stays declined, and a list of models is a 400.
  [MODELS.haiku55]: { contextWindow: 1_000_000, serverFallback: false },
});

/** The context window assumed for a model Hermod does not know: small on purpose, so compression starts early. */
export const UNKNOWN_MODEL_CONTEXT_WINDOW = 200_000;

export function isKnownModel(model: unknown): model is ModelId {
  return typeof model === "string" && Object.hasOwn(MODEL_INFO, model);
}

/** The model's context window in tokens (1M for the models in MODELS). */
export function contextWindow(model: string): number {
  return isKnownModel(model) ? MODEL_INFO[model].contextWindow : UNKNOWN_MODEL_CONTEXT_WINDOW;
}

/** True when the model accepts the server-side refusal fallback `fallbacks: "default"`. False for unknown models. */
export function supportsServerFallback(model: string): boolean {
  return isKnownModel(model) && MODEL_INFO[model].serverFallback;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
