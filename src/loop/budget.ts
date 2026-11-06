/**
 * Run budgets, checked before every model call: model calls per run, USD (the run's cap and what is left of the
 * agent's monthly cap, whichever is smaller) and wall clock. The USD side uses CostTracker from src/model/cost.ts.
 */
import { CostTracker, estimateMaxCost } from "../model/cost.js";
import type { AgentConfig, AgentRecord, RunEnd, Storage } from "../types.js";

export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_MAX_COST_USD = 1;

export interface Budget {
  maxIterations: number;
  /** The run's own cap (config.budget.maxCostUsd). */
  runCapUsd: number;
  /** What was left of the agent's monthly cap when the run started; null = no monthly cap. */
  monthlyRemainingUsd: number | null;
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
  let monthlyRemainingUsd: number | null = null;
  if (agent.monthlyCostCapUsd !== null && agent.monthlyCostCapUsd !== undefined) {
    const spent = await storage.costs.sum({ agentId: agent.id, since: startOfMonthUtc(now) });
    monthlyRemainingUsd = Math.max(0, agent.monthlyCostCapUsd - (Number.isFinite(spent) ? spent : Infinity));
  }
  const capUsd = Math.min(runCapUsd, monthlyRemainingUsd ?? Infinity);
  return {
    maxIterations,
    runCapUsd,
    monthlyRemainingUsd,
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

/** True when the wall clock is used up (checked between retries too). */
export function wallClockUsed(budget: Budget, nowMs: number): boolean {
  return budget.maxWallMs !== null && nowMs - budget.startedAtMs >= budget.maxWallMs;
}
