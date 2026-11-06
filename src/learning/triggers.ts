/**
 * When a session is due for a post-session review (Hermes's numbers): every 10 user turns since the last memory
 * review, or every 10 tool rounds since the last skill review. Both are configurable.
 *
 * Call markReviewed AFTER the reviewed run has finished: runAgent writes the session's counters when a run ends,
 * so a mark made while the session is running would be overwritten.
 */
import type { Id, SessionCounters, SessionRecord, Storage } from "../types.js";

export interface ReviewThresholds {
  /** User turns since the last memory review. Default 10. */
  memoryEveryUserTurns: number;
  /** Tool rounds since the last skill review. Default 10. */
  skillsEveryToolIterations: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: Readonly<ReviewThresholds> = Object.freeze({
  memoryEveryUserTurns: 10,
  skillsEveryToolIterations: 10,
});

export interface ReviewDue {
  memory: boolean;
  skills: boolean;
}

function threshold(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`shouldReview: ${name} must be a whole number, 1 or more (got ${String(value)}).`);
  }
  return value;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Which reviews are due for these counters. A counter below its last mark (a reset) is never due. */
export function shouldReview(
  counters: SessionCounters,
  thresholds: Partial<ReviewThresholds> = DEFAULT_REVIEW_THRESHOLDS,
): ReviewDue {
  const memoryEvery = threshold(thresholds.memoryEveryUserTurns ?? DEFAULT_REVIEW_THRESHOLDS.memoryEveryUserTurns, "memoryEveryUserTurns");
  const skillsEvery = threshold(
    thresholds.skillsEveryToolIterations ?? DEFAULT_REVIEW_THRESHOLDS.skillsEveryToolIterations,
    "skillsEveryToolIterations",
  );
  const turns = count(counters?.userTurns) - count(counters?.lastMemoryReviewTurn);
  const iterations = count(counters?.toolIterations) - count(counters?.lastSkillReviewIteration);
  return { memory: turns >= memoryEvery, skills: iterations >= skillsEvery };
}

/**
 * Records that a review ran: memory → lastMemoryReviewTurn = userTurns; skills → lastSkillReviewIteration =
 * toolIterations. Other counters are kept. Returns the updated session, or null when it does not exist.
 */
export async function markReviewed(storage: Storage, sessionId: Id, kinds: Partial<ReviewDue>): Promise<SessionRecord | null> {
  const session = await storage.sessions.get(sessionId);
  if (!session) return null;
  if (kinds?.memory !== true && kinds?.skills !== true) return session;
  const counters: SessionCounters = { ...session.counters };
  if (kinds.memory === true) counters.lastMemoryReviewTurn = counters.userTurns;
  if (kinds.skills === true) counters.lastSkillReviewIteration = counters.toolIterations;
  return storage.sessions.update(sessionId, { counters });
}
