/** When a session is due for a review, and marking it reviewed. */
import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_THRESHOLDS, markReviewed, shouldReview } from "../../../src/learning/index.js";
import type { SessionCounters } from "../../../src/types.js";
import { AGENT, setup } from "./helpers.js";

function counters(partial: Partial<SessionCounters>): SessionCounters {
  return { userTurns: 0, toolIterations: 0, lastMemoryReviewTurn: 0, lastSkillReviewIteration: 0, ...partial };
}

describe("shouldReview", () => {
  it("uses Hermes's defaults: 10 user turns, 10 tool rounds", () => {
    expect(DEFAULT_REVIEW_THRESHOLDS).toEqual({ memoryEveryUserTurns: 10, skillsEveryToolIterations: 10 });
  });

  it("memory is due at exactly 10 user turns since the last memory review, not at 9", () => {
    expect(shouldReview(counters({ userTurns: 9 }))).toEqual({ memory: false, skills: false });
    expect(shouldReview(counters({ userTurns: 10 }))).toEqual({ memory: true, skills: false });
    expect(shouldReview(counters({ userTurns: 19, lastMemoryReviewTurn: 10 }))).toEqual({ memory: false, skills: false });
    expect(shouldReview(counters({ userTurns: 20, lastMemoryReviewTurn: 10 }))).toEqual({ memory: true, skills: false });
  });

  it("skills are due at exactly 10 tool rounds since the last skill review, not at 9", () => {
    expect(shouldReview(counters({ toolIterations: 9 }))).toEqual({ memory: false, skills: false });
    expect(shouldReview(counters({ toolIterations: 10 }))).toEqual({ memory: false, skills: true });
    expect(shouldReview(counters({ toolIterations: 14, lastSkillReviewIteration: 5 }))).toEqual({ memory: false, skills: false });
    expect(shouldReview(counters({ toolIterations: 15, lastSkillReviewIteration: 5 }))).toEqual({ memory: false, skills: true });
  });

  it("both can be due; the two counters are independent", () => {
    expect(shouldReview(counters({ userTurns: 12, toolIterations: 30, lastSkillReviewIteration: 20 }))).toEqual({
      memory: true,
      skills: true,
    });
  });

  it("thresholds are configurable (and partial overrides keep the other default)", () => {
    expect(shouldReview(counters({ userTurns: 3 }), { memoryEveryUserTurns: 3, skillsEveryToolIterations: 2 })).toEqual({
      memory: true,
      skills: false,
    });
    expect(shouldReview(counters({ toolIterations: 2 }), { skillsEveryToolIterations: 2 })).toEqual({ memory: false, skills: true });
    expect(shouldReview(counters({ userTurns: 9 }), { skillsEveryToolIterations: 2 })).toEqual({ memory: false, skills: false });
  });

  it("rejects thresholds below 1 or not whole", () => {
    expect(() => shouldReview(counters({}), { memoryEveryUserTurns: 0 })).toThrow(TypeError);
    expect(() => shouldReview(counters({}), { skillsEveryToolIterations: 1.5 })).toThrow(TypeError);
  });

  it("a counter below its last mark (a reset) is never due", () => {
    expect(shouldReview(counters({ userTurns: 2, lastMemoryReviewTurn: 40 }))).toEqual({ memory: false, skills: false });
  });
});

describe("markReviewed", () => {
  it("sets lastMemoryReviewTurn and/or lastSkillReviewIteration to the current counters", async () => {
    const s = await setup();
    const session = await s.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    await s.storage.sessions.update(session.id, { counters: counters({ userTurns: 12, toolIterations: 23, lastSkillReviewIteration: 3 }) });
    expect(shouldReview((await s.storage.sessions.get(session.id))!.counters)).toEqual({ memory: true, skills: true });

    const afterMemory = await markReviewed(s.storage, session.id, { memory: true });
    expect(afterMemory?.counters).toEqual(counters({ userTurns: 12, toolIterations: 23, lastMemoryReviewTurn: 12, lastSkillReviewIteration: 3 }));
    expect(shouldReview(afterMemory!.counters)).toEqual({ memory: false, skills: true });

    const afterSkills = await markReviewed(s.storage, session.id, { skills: true });
    expect(afterSkills?.counters).toEqual(counters({ userTurns: 12, toolIterations: 23, lastMemoryReviewTurn: 12, lastSkillReviewIteration: 23 }));
    expect((await s.storage.sessions.get(session.id))?.counters.lastSkillReviewIteration).toBe(23);
    expect(shouldReview(afterSkills!.counters)).toEqual({ memory: false, skills: false });
  });

  it("marks both at once, leaves the session alone for no kinds, and returns null for a missing session", async () => {
    const s = await setup();
    const session = await s.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
    await s.storage.sessions.update(session.id, { counters: counters({ userTurns: 4, toolIterations: 6 }) });
    const untouched = await markReviewed(s.storage, session.id, {});
    expect(untouched?.counters).toEqual(counters({ userTurns: 4, toolIterations: 6 }));
    const both = await markReviewed(s.storage, session.id, { memory: true, skills: true });
    expect(both?.counters).toEqual(counters({ userTurns: 4, toolIterations: 6, lastMemoryReviewTurn: 4, lastSkillReviewIteration: 6 }));
    expect(await markReviewed(s.storage, "missing", { memory: true })).toBeNull();
  });
});
