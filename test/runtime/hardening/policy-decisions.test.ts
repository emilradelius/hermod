/**
 * Hardening, policy block: a shadow draft is never approved (J), the curator does nothing for an agent that is off
 * (N), and one case-insensitive check decides who is not a person, for proposals and modes alike (O).
 */
import { describe, expect, it } from "vitest";
import { curate } from "../../../src/learning/index.js";
import { MemoryService } from "../../../src/memory/index.js";
import { getMode, scoreDraft, setMode } from "../../../src/modes/index.js";
import { ProposalRefusedError, ProposalService } from "../../../src/proposals/index.js";
import { ModeError } from "../../../src/modes/index.js";
import { NON_HUMAN_ACTOR_KINDS, isNonHumanActor } from "../../../src/safety/index.js";
import { SkillService } from "../../../src/skills/index.js";
import { AgentOffError, type ProposalRecord } from "../../../src/types.js";
import { AGENT, NOW, OWNER, entries, world, type World } from "./policy-helpers.js";

const DAY_MS = 86_400_000;

async function actionDraft(w: World, shadow: boolean): Promise<ProposalRecord> {
  return w.storage.proposals.create({
    agentId: AGENT,
    sessionId: null,
    kind: "action",
    target: "send_reply",
    payload: { kind: "action", tool: "send_reply", input: { text: "Draft reply" }, draftText: "Draft reply" },
    evidence: [{ kind: "log", ref: "draft" }],
    rationale: "A draft.",
    createdBy: `agent:${AGENT}`,
    shadow,
  });
}

async function memoryDraft(w: World, shadow: boolean): Promise<ProposalRecord> {
  return w.storage.proposals.create({
    agentId: AGENT,
    sessionId: null,
    kind: "memory",
    target: "memory",
    payload: { kind: "memory", store: "memory", ops: [{ op: "add", text: "The build uses pnpm." }] },
    evidence: [{ kind: "log", ref: "draft" }],
    rationale: "A draft.",
    createdBy: `agent:${AGENT}`,
    shadow,
  });
}

function withExecutor(w: World): { proposals: ProposalService; ran: unknown[] } {
  const ran: unknown[] = [];
  const proposals = new ProposalService({
    storage: w.storage,
    memory: w.memory,
    skills: w.skills,
    now: () => NOW,
    executeAction: async (payload) => {
      ran.push(payload);
      return { ok: true };
    },
  });
  return { proposals, ran };
}

describe("J: a shadow draft is scored, never run", () => {
  it("approving a shadow action draft is refused (not_allowed); nothing runs, it stays pending, no approval audit", async () => {
    const w = await world({ mode: "shadow" });
    const { proposals, ran } = withExecutor(w);
    const draft = await actionDraft(w, true);
    const error = await proposals.approve(draft.id, OWNER).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProposalRefusedError);
    expect((error as ProposalRefusedError).code).toBe("not_allowed");
    expect((error as ProposalRefusedError).message).toMatch(/a shadow draft is scored, not run/);
    expect(ran).toEqual([]);
    expect((await w.storage.proposals.get(draft.id))?.status).toBe("pending");
    expect(await w.storage.audit.list({ action: "proposal.approve" })).toEqual([]);
    // It can still be scored, and rejected.
    expect((await scoreDraft(proposals, draft.id, "as_is", OWNER))?.score).toBe("as_is");
    expect((await proposals.reject(draft.id, OWNER))?.status).toBe("rejected");
  });

  it("a shadow memory draft is not applied either", async () => {
    const w = await world({ mode: "shadow" });
    const draft = await memoryDraft(w, true);
    await expect(w.proposals.approve(draft.id, OWNER)).rejects.toMatchObject({ code: "not_allowed" });
    expect(await entries(w, "memory")).toEqual([]);
    expect((await w.storage.proposals.get(draft.id))?.status).toBe("pending");
  });

  it("a proposal that is not a shadow draft is still approved and run", async () => {
    const w = await world({ mode: "supervised" });
    const { proposals, ran } = withExecutor(w);
    const proposal = await actionDraft(w, false);
    expect((await proposals.approve(proposal.id, OWNER))?.status).toBe("applied");
    expect(ran).toHaveLength(1);
    const memory = await memoryDraft(w, false);
    expect((await w.proposals.approve(memory.id, OWNER))?.status).toBe("applied");
    expect(await entries(w, "memory")).toEqual(["The build uses pnpm."]);
  });
});

describe("N: the curator does nothing for an agent that is off", () => {
  async function staleSkill(w: World): Promise<void> {
    await w.skills.createSkill(
      AGENT,
      { name: "weekly-review", description: "The weekly review steps. Use it on Fridays.", body: "1. Look back." },
      { actor: OWNER },
    );
  }

  it("throws AgentOffError before any write, also in a dry run", async () => {
    const w = await world({ mode: "off" });
    await staleSkill(w);
    const before = await w.storage.audit.list({});
    const later = new Date(NOW.getTime() + 45 * DAY_MS);
    await expect(curate(w.storage, { agentId: AGENT, now: later })).rejects.toBeInstanceOf(AgentOffError);
    await expect(curate(w.storage, { agentId: AGENT, now: later, dryRun: true })).rejects.toBeInstanceOf(AgentOffError);
    expect((await w.storage.skills.get(AGENT, "weekly-review"))?.status).toBe("active");
    expect(await w.storage.audit.list({})).toEqual(before);
  });

  it("an agent that is on is curated as before; a missing agent is a programming error", async () => {
    const w = await world({ mode: "shadow" });
    await staleSkill(w);
    const report = await curate(w.storage, { agentId: AGENT, now: new Date(NOW.getTime() + 45 * DAY_MS) });
    expect(report.changes.map((c) => c.to)).toEqual(["archived"]);
    await expect(curate(w.storage, { agentId: "no-such-agent", now: NOW })).rejects.toThrow(
      new TypeError('curate: there is no agent "no-such-agent".'),
    );
  });
});

describe("O: one case-insensitive check of who is not a person", () => {
  const nonHuman = [
    "agent",
    "agent:x",
    "Agent:x",
    "AGENT:policy-agent",
    " job:nightly ",
    "JOB:x",
    "Review",
    "review:abc",
    "system",
    "System",
    "curator",
    "CURATOR:run",
    "scheduler",
    "Scheduler:tick",
    "delegate",
    "delegate:child-1",
    "agent :x",
    "ＡＧＥＮＴ:x",
  ];
  const people = ["user:owner", "Emil", "agentina", "jobs@example.test", "reviewer:anna", "systems-team", "user:agent"];

  it("covers agent, job, review, system, curator, scheduler and delegate", () => {
    expect([...NON_HUMAN_ACTOR_KINDS].sort()).toEqual(["agent", "curator", "delegate", "job", "review", "scheduler", "system"]);
    for (const actor of nonHuman) expect(isNonHumanActor(actor), JSON.stringify(actor)).toBe(true);
    for (const actor of people) expect(isNonHumanActor(actor), JSON.stringify(actor)).toBe(false);
  });

  it("no non-human actor can approve, reject, mark applied or score a proposal", async () => {
    const w = await world();
    const memory = new MemoryService({ storage: w.storage, now: () => NOW });
    const skills = new SkillService({ storage: w.storage, now: () => NOW });
    const proposals = new ProposalService({ storage: w.storage, memory, skills, now: () => NOW });
    const proposal = await actionDraft(w, false);
    for (const actor of nonHuman) {
      for (const decide of [
        () => proposals.approve(proposal.id, actor),
        () => proposals.reject(proposal.id, actor),
        () => proposals.markApplied(proposal.id, actor),
        () => proposals.score(proposal.id, "as_is", actor),
      ]) {
        await expect(decide(), JSON.stringify(actor)).rejects.toMatchObject({ code: "not_allowed" });
      }
    }
    expect((await w.storage.proposals.get(proposal.id))?.status).toBe("pending");
    expect(await w.storage.audit.list({})).toEqual([]);
  });

  it("no non-human actor can change a mode or score a draft", async () => {
    const w = await world({ mode: "shadow" });
    const draft = await actionDraft(w, true);
    for (const actor of nonHuman) {
      await expect(setMode(w.storage, AGENT, "autonomous", actor), JSON.stringify(actor)).rejects.toBeInstanceOf(ModeError);
      await expect(scoreDraft(w.proposals, draft.id, "as_is", actor), JSON.stringify(actor)).rejects.toBeInstanceOf(ModeError);
    }
    expect(await getMode(w.storage, AGENT)).toBe("shadow");
    expect((await w.storage.proposals.get(draft.id))?.score).toBeNull();
    // A person still can.
    expect((await setMode(w.storage, AGENT, "supervised", OWNER)).mode).toBe("supervised");
  });
});
