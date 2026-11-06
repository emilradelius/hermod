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
 *
 * Third hardening round:
 * - The prompt size is conservative (PromptSize): estimatePromptTokens counts non-ASCII text at one token per code
 *   point or more, and from the second call on the real prompt size the API reported (usage) plus an estimate of what
 *   was added since is a floor. Haiku 5.5's long-prompt tier is priced whenever the prompt could pass its threshold
 *   (PromptSize.tierTokens: the known part plus LONG_PROMPT_MARGIN times the estimated part).
 * - A request that carries the server-side refusal fallback keeps it only when two full attempts fit (the request
 *   model plus the most expensive fallback target, estimateBudgetCost with fallbackHop); otherwise it is sent with
 *   refusalFallback: false and clamped for one attempt.
 * - Runs of the same agent that go on at the same time reserve each call's worst case before it is sent
 *   (reserveUsd) and release it once the call's cost is recorded or the call failed; the monthly remainder subtracts
 *   the open reservations. Reservations live in this process only (per storage object and agent): runs in other
 *   processes see each other's spend only once it is recorded.
 */
import { CostTracker, estimateBudgetCost, type BudgetCostOptions } from "../model/cost.js";
import type { AgentConfig, AgentRecord, Id, RunEnd, Storage } from "../types.js";

export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_MAX_COST_USD = 1;
/** Below this many output tokens a call is not worth making; the run ends with "budget_cost" instead. */
export const MIN_USEFUL_OUTPUT_TOKENS = 128;
/** How far an estimated prompt size may be below the real one when picking a long-prompt price tier. */
export const LONG_PROMPT_MARGIN = 2;

/** A prompt size for budgets: `tokens` prices the prompt, `tierTokens` (an upper bound) picks the price tier. */
export interface PromptSize {
  tokens: number;
  tierTokens: number;
}

/**
 * The conservative size of a prompt. `estimate` is estimatePromptTokens of the whole request. `known`, when the
 * conversation's last prompt size is known from usage: its real token count and the estimate of what was added
 * since. A size that is not a finite number of 0 or more is Infinity (the call is refused).
 */
export function promptSize(estimate: number, known?: { tokens: number; addedEstimate: number }): PromptSize {
  const est = finiteOrInfinity(estimate);
  if (!known) return { tokens: est, tierTokens: est * LONG_PROMPT_MARGIN };
  const base = finiteOrInfinity(known.tokens);
  const added = finiteOrInfinity(known.addedEstimate);
  const tokens = Math.max(est, base + added);
  return { tokens, tierTokens: Math.max(tokens, base + added * LONG_PROMPT_MARGIN) };
}

function finiteOrInfinity(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : Infinity;
}

// ── in-process reservations (per storage object, per agent) ───────────────────────────────────────────────────

const reservations = new WeakMap<object, Map<Id, number>>();

/** The USD reserved now by calls of `agentId` in flight in this process (same storage object). */
export function reservedUsd(storage: Storage, agentId: Id): number {
  return reservations.get(storage)?.get(agentId) ?? 0;
}

/**
 * Reserves `usd` of the agent's monthly cap for a call about to be sent. Returns the release function; calling it
 * more than once releases once. Per process: another process never sees the reservation.
 */
export function reserveUsd(storage: Storage, agentId: Id, usd: number): () => void {
  const amount = typeof usd === "number" && usd > 0 ? usd : 0;
  if (amount === 0) return () => {};
  let byAgent = reservations.get(storage);
  if (!byAgent) {
    byAgent = new Map();
    reservations.set(storage, byAgent);
  }
  byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + amount);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const map = reservations.get(storage);
    if (!map) return;
    const left = (map.get(agentId) ?? 0) - amount;
    // Float sums: a remainder this small is what is left of released reservations, not an open one.
    if (left <= 1e-12) map.delete(agentId);
    else map.set(agentId, left);
  };
}

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
  next: { model: string; promptTokens: number | PromptSize; extraSpentUsd: number; nowMs: number },
): RunEnd | null {
  if (state.iteration >= budget.maxIterations) return "budget_iterations";
  if (budget.maxWallMs !== null && next.nowMs - budget.startedAtMs >= budget.maxWallMs) return "budget_time";
  const size = typeof next.promptTokens === "number" ? { tokens: next.promptTokens, tierTokens: next.promptTokens } : next.promptTokens;
  if (!Number.isFinite(size.tokens) || !(size.tokens >= 0)) return "budget_cost";
  const promptCost = estimateBudgetCost(next.model, Math.ceil(size.tokens), 0, { tierPromptTokens: size.tierTokens });
  if (budget.tracker.capUsd <= 0 || budget.tracker.wouldExceed(promptCost + next.extraSpentUsd)) return "budget_cost";
  return null;
}

async function monthlyLeft(storage: Storage, agentId: Id, capUsd: number | null, now: Date): Promise<number | null> {
  if (capUsd === null) return null;
  const spent = await storage.costs.sum({ agentId, since: startOfMonthUtc(now) });
  // Calls of this agent in flight in this process count as spent (reserveUsd).
  return Math.max(0, capUsd - (Number.isFinite(spent) ? spent : Infinity) - reservedUsd(storage, agentId));
}

/**
 * What is left of the agent's monthly cap NOW (a fresh read of this month's spend, minus this process's open
 * reservations for the agent), or null when it has none.
 */
export function monthlyRemainingNow(budget: Budget, storage: Storage, now: Date): Promise<number | null> {
  return monthlyLeft(storage, budget.agentId, budget.monthlyCapUsd, now);
}

/**
 * The most the next call may cost: min(run cap − this run's spend − `extraSpentUsd` (sub-agents), the monthly cap
 * left now). The month's spend is read fresh, and it already holds this run's recorded calls.
 */
export async function availableUsd(budget: Budget, storage: Storage, now: Date, extraSpentUsd: number): Promise<number> {
  const read = await readMonthSpend(budget, storage, now);
  return availableAfterRead(budget, storage, read, extraSpentUsd);
}

/** This month's recorded spend for the agent (null when it has no monthly cap): the async half of availableUsd. */
export async function readMonthSpend(budget: Budget, storage: Storage, now: Date): Promise<number | null> {
  if (budget.monthlyCapUsd === null) return null;
  const spent = await storage.costs.sum({ agentId: budget.agentId, since: startOfMonthUtc(now) });
  return Number.isFinite(spent) ? spent : Infinity;
}

/**
 * The synchronous half of availableUsd: what is left, given the month's spend just read, minus the open
 * reservations as they are NOW. A caller that reserves (reserveUsd) right after, with no await in between, cannot
 * race another run of the agent in this process.
 */
export function availableAfterRead(budget: Budget, storage: Storage, monthSpent: number | null, extraSpentUsd: number): number {
  // tracker.capUsd is min(run cap, monthly cap left at the start): the start value stays a bound as well.
  const run = Math.max(0, budget.tracker.capUsd - budget.tracker.totalUsd - Math.max(0, extraSpentUsd));
  if (budget.monthlyCapUsd === null || monthSpent === null) return run;
  const month = Math.max(0, budget.monthlyCapUsd - monthSpent - reservedUsd(storage, budget.agentId));
  return Math.max(0, Math.min(run, month));
}

/**
 * The max_tokens for the next call so that its worst-case cost (estimateBudgetCost(model, promptTokens, maxTokens,
 * options): the tier and the refusal fallback hop as `options` say) fits under `available`; never more than
 * `maxTokens`. Null when the result would be below min(`floor`, `maxTokens`), or the prompt size is not a finite
 * number of 0 or more: the call is not worth making (end the run with "budget_cost").
 */
export function clampMaxTokens(
  model: string,
  promptTokens: number,
  maxTokens: number,
  available: number,
  floor: number = MIN_USEFUL_OUTPUT_TOKENS,
  options: BudgetCostOptions = {},
): number | null {
  if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens < 0) return null;
  const prompt = Math.ceil(promptTokens);
  const wanted = Math.max(0, Math.floor(maxTokens));
  const least = Math.min(Math.max(1, Math.floor(floor)), wanted);
  if (!(available >= 0)) return null;
  if (available === Infinity) return wanted >= least && wanted > 0 ? wanted : null;
  const cost = (n: number): number => estimateBudgetCost(model, prompt, n, options);
  const base = cost(0);
  if (base > available) return null;
  const perToken = (cost(1_000_000) - base) / 1_000_000;
  let n = perToken > 0 ? Math.min(wanted, Math.floor((available - base) / perToken)) : wanted;
  // Float rounding: step until n is the largest count whose worst case really fits (a step or two at most).
  while (n > 0 && cost(n) > available) n -= 1;
  for (let step = 0; step < 4 && n < wanted && cost(n + 1) <= available; step += 1) n += 1;
  return n >= least && n > 0 ? n : null;
}

/** True when the wall clock is used up (checked between retries too). */
export function wallClockUsed(budget: Budget, nowMs: number): boolean {
  return budget.maxWallMs !== null && nowMs - budget.startedAtMs >= budget.maxWallMs;
}
