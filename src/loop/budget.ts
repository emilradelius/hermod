/**
 * Run budgets, checked before every model call: model calls per run, USD (the run's cap and what is left of the
 * agent's monthly cap, whichever is smaller) and wall clock. The USD side uses CostTracker from src/model/cost.ts.
 *
 * The USD cap bounds output too (stricter since the hardening pass): before every call, the loop re-reads what the
 * month has spent so far (storage.costs, so runs that go on at the same time count each other's spend) and clamps
 * the call's max_tokens so the WORST case (estimateMaxCost: the whole prompt as a cache write plus every output token)
 * fits under min(run cap left, monthly cap left). When the clamped value would be below a small useful floor
 * (MIN_USEFUL_OUTPUT_TOKENS, or the configured max_tokens when that is smaller) the call is not made and the run ends
 * with "budget_cost". The same applies to every attempt: a retry, the call after a fallback-model switch, the
 * compression summary call and a delegate child's calls (a child's run cap is its slice).
 */
import { CostTracker, estimateMaxCost } from "../model/cost.js";
import type { AgentConfig, AgentRecord, Id, RunEnd, Storage } from "../types.js";

export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_MAX_COST_USD = 1;
/** Below this many output tokens a call is not worth making; the run ends with "budget_cost" instead. */
export const MIN_USEFUL_OUTPUT_TOKENS = 128;

export interface Budget {
  maxIterations: number;
  /** The run's own cap (config.budget.maxCostUsd). */
  runCapUsd: number;
  /** What was left of the agent's monthly cap when the run started; null = no monthly cap. */
  monthlyRemainingUsd: number | null;
  /** The agent's monthly cap; null = none. What is left of it is re-read before every call (monthlyRemainingNow). */
  monthlyCapUsd: number | null;
  agentId: Id;
  maxWallMs: number | null;
  startedAtMs: number;
  /** Tracks the run's own model calls against min(runCapUsd, monthlyRemainingUsd). */
  tracker: CostTracker;
}

/** The first moment of the month (UTC) that `date` is in. */
export function startOfMonthUtc(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export async function createBudget(
  config: AgentConfig,
  agent: AgentRecord,
  storage: Storage,
  now: Date,
): Promise<Budget> {
  const maxIterations = config.budget?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const runCapUsd = config.budget?.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const monthlyCapUsd = agent.monthlyCostCapUsd ?? null;
  const monthlyRemainingUsd = await monthlyLeft(storage, agent.id, monthlyCapUsd, now);
  const capUsd = Math.min(runCapUsd, monthlyRemainingUsd ?? Infinity);
  return {
    maxIterations,
    runCapUsd,
    monthlyRemainingUsd,
    monthlyCapUsd,
    agentId: agent.id,
    maxWallMs: config.budget?.maxWallMs ?? null,
    startedAtMs: now.getTime(),
    tracker: new CostTracker({ capUsd }),
  };
}

/**
 * Why the next call must not be made, or null. `promptTokens` is the next prompt's estimated size: the call is
 * refused when even its prompt alone would go over what is left (output is unknown until it is generated).
 * `extraSpentUsd` is money spent outside the tracker (sub-agents).
 */
export function budgetStop(
  budget: Budget,
  state: { iteration: number },
  next: { model: string; promptTokens: number; extraSpentUsd: number; nowMs: number },
): RunEnd | null {
  if (state.iteration >= budget.maxIterations) return "budget_iterations";
  if (budget.maxWallMs !== null && next.nowMs - budget.startedAtMs >= budget.maxWallMs) return "budget_time";
  const promptCost = estimateMaxCost(next.model, Math.max(0, Math.ceil(next.promptTokens)), 0);
  if (budget.tracker.capUsd <= 0 || budget.tracker.wouldExceed(promptCost + next.extraSpentUsd)) return "budget_cost";
  return null;
}

async function monthlyLeft(storage: Storage, agentId: Id, capUsd: number | null, now: Date): Promise<number | null> {
  if (capUsd === null) return null;
  const spent = await storage.costs.sum({ agentId, since: startOfMonthUtc(now) });
  return Math.max(0, capUsd - (Number.isFinite(spent) ? spent : Infinity));
}

/** What is left of the agent's monthly cap NOW (a fresh read of this month's spend), or null when it has none. */
export function monthlyRemainingNow(budget: Budget, storage: Storage, now: Date): Promise<number | null> {
  return monthlyLeft(storage, budget.agentId, budget.monthlyCapUsd, now);
}

/**
 * The most the next call may cost: min(run cap − this run's spend − `extraSpentUsd` (sub-agents), the monthly cap
 * left now). The month's spend is read fresh, and it already holds this run's recorded calls.
 */
export async function availableUsd(budget: Budget, storage: Storage, now: Date, extraSpentUsd: number): Promise<number> {
  // tracker.capUsd is min(run cap, monthly cap left at the start): the start value stays a bound as well.
  const run = Math.max(0, budget.tracker.capUsd - budget.tracker.totalUsd - Math.max(0, extraSpentUsd));
  const month = await monthlyRemainingNow(budget, storage, now);
  return month === null ? run : Math.max(0, Math.min(run, month));
}

/**
 * The max_tokens for the next call so that its worst-case cost (estimateMaxCost(model, promptTokens, maxTokens))
 * fits under `availableUsd`; never more than `maxTokens`. Null when the result would be below
 * min(`floor`, `maxTokens`): the call is not worth making (end the run with "budget_cost").
 */
export function clampMaxTokens(
  model: string,
  promptTokens: number,
  maxTokens: number,
  available: number,
  floor: number = MIN_USEFUL_OUTPUT_TOKENS,
): number | null {
  const prompt = Math.max(0, Math.ceil(Number.isFinite(promptTokens) ? promptTokens : 0));
  const wanted = Math.max(0, Math.floor(maxTokens));
  const least = Math.min(Math.max(1, Math.floor(floor)), wanted);
  if (!(available >= 0)) return null;
  if (available === Infinity) return wanted >= least && wanted > 0 ? wanted : null;
  const base = estimateMaxCost(model, prompt, 0);
  if (base > available) return null;
  const perToken = (estimateMaxCost(model, prompt, 1_000_000) - base) / 1_000_000;
  let n = perToken > 0 ? Math.min(wanted, Math.floor((available - base) / perToken)) : wanted;
  // Float rounding: step until n is the largest count whose worst case really fits (a step or two at most).
  while (n > 0 && estimateMaxCost(model, prompt, n) > available) n -= 1;
  for (let step = 0; step < 4 && n < wanted && estimateMaxCost(model, prompt, n + 1) <= available; step += 1) n += 1;
  return n >= least && n > 0 ? n : null;
}

/** True when the wall clock is used up (checked between retries too). */
export function wallClockUsed(budget: Budget, nowMs: number): boolean {
  return budget.maxWallMs !== null && nowMs - budget.startedAtMs >= budget.maxWallMs;
}
