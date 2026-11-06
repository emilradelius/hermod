/**
 * Hardening round 3, policy block (R7): an attended chat that some run continued unattended (the app wrote that
 * run's user message) no longer counts as the person's words. The loop records meta.unattendedRun (and
 * meta.unattendedRunAt) on the session row once and never clears it; the review reads it and makes every write from
 * such a session a proposal (fail safe: any recorded value counts).
 */
import { describe, expect, it } from "vitest";
import { reviewSession, reviewToolset, type ReviewLedger } from "../../../src/learning/index.js";
import { UNATTENDED_AT_META_KEY, UNATTENDED_META_KEY } from "../../../src/loop/taint.js";
import { runAgent } from "../../../src/loop/index.js";
import { FakeModelClient, textMessage, toolUseMessage } from "../../../src/testing/index.js";
import type { MessageRecord, SessionRecord, ToolDef } from "../../../src/types.js";
import { AGENT, NOW, config, entries, toolCtx, world, type World } from "./policy-helpers.js";

const OWN = "I always want metric units in answers.";
const QUOTE = "I always want metric units";
const FACT = "User prefers metric units.";

function reviewDeps(w: World, model: FakeModelClient) {
  return { storage: w.storage, model, memory: w.memory, skills: w.skills, proposals: w.proposals, now: () => NOW, sleep: async () => {} };
}

async function reviewCiting(w: World, session: SessionRecord, message: MessageRecord) {
  const model = new FakeModelClient([
    toolUseMessage([
      {
        name: "memory",
        input: { store: "user", ops: [{ op: "add", text: FACT }], evidence: [{ messageId: message.id, quote: QUOTE }], rationale: "The user said so." },
      },
    ]),
    textMessage("Done."),
  ]);
  return reviewSession(session.id, reviewDeps(w, model));
}

/** An attended chat with one user message in the person's own words, and optional meta on its row. */
async function attendedChat(w: World, meta?: Record<string, unknown>): Promise<{ session: SessionRecord; message: MessageRecord }> {
  const created = await w.storage.sessions.create({ agentId: AGENT, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });
  const message = await w.storage.messages.append(created.id, { role: "user", content: [{ type: "text", text: OWN }], text: OWN });
  if (meta) await w.storage.sessions.update(created.id, { meta });
  return { session: (await w.storage.sessions.get(created.id)) as SessionRecord, message };
}

describe("R7: the review reads meta.unattendedRun", () => {
  it("the keys are the ones the loop writes", () => {
    expect(UNATTENDED_META_KEY).toBe("unattendedRun");
    expect(UNATTENDED_AT_META_KEY).toBe("unattendedRunAt");
  });

  it("control: a clean attended chat in the person's own words may still add directly", async () => {
    const w = await world();
    const { session, message } = await attendedChat(w);
    const outcome = await reviewCiting(w, session, message);
    expect(outcome.applied).toEqual([{ store: "user", ops: 1 }]);
    expect(await entries(w, "user")).toEqual([FACT]);
  });

  it("an attended chat marked unattendedRun: the add becomes a proposal, nothing is written", async () => {
    const w = await world();
    const { session, message } = await attendedChat(w, { unattendedRun: true, unattendedRunAt: NOW.toISOString() });
    expect(session.attended).toBe(true);
    const outcome = await reviewCiting(w, session, message);
    expect(outcome.applied).toEqual([]);
    expect(outcome.proposals).toHaveLength(1);
    expect(await entries(w, "user")).toEqual([]);
  });

  const failSafe: Array<[string, Record<string, unknown>]> = [
    ["only the time recorded", { unattendedRunAt: NOW.toISOString() }],
    ["a non-boolean flag", { unattendedRun: "yes" }],
    ["the flag as 1", { unattendedRun: 1 }],
  ];
  for (const [label, meta] of failSafe) {
    it(`fail safe, ${label}: a proposal, never a direct write`, async () => {
      const w = await world();
      const { session, message } = await attendedChat(w, meta);
      const outcome = await reviewCiting(w, session, message);
      expect(outcome.applied).toEqual([]);
      expect(outcome.proposals).toHaveLength(1);
      expect(await entries(w, "user")).toEqual([]);
    });
  }

  it("the flag set after the review started (read fresh at the write) still makes it a proposal", async () => {
    const w = await world();
    const { session: stale, message } = await attendedChat(w);
    const ledger: ReviewLedger = { proposals: [], refused: [], applied: [] };
    const tools = reviewToolset({ ...reviewDeps(w, new FakeModelClient()), reviewed: stale, ledger });
    const memory = tools.tools.find((t) => t.name === "memory") as ToolDef;
    // Continued unattended while the review was going on: the loop recorded it on the row.
    await w.storage.sessions.update(stale.id, { meta: { unattendedRun: true, unattendedRunAt: NOW.toISOString() } });
    const review = await w.storage.sessions.create({ agentId: AGENT, kind: "review", attended: false, memorySnapshot: "", skillsIndex: "" });
    const input = { store: "user", ops: [{ op: "add", text: FACT }], evidence: [{ messageId: message.id, quote: QUOTE }], rationale: "The user said so." };
    const out = String(await memory.run(memory.input.parse(input), toolCtx(w.storage, review.id, { attended: false })));
    expect(out).toContain("Proposed");
    expect(ledger.applied).toEqual([]);
    expect(await entries(w, "user")).toEqual([]);
  });

  it("end to end: an attended chat continued with runAgent({ sessionId, attended: false }) and then reviewed only proposes", async () => {
    const w = await world();
    w.model.push(textMessage("Hello."), textMessage("Noted."));
    const first = await runAgent(config(w), { userMessage: "Hello there." }, w.deps);
    expect(first.end).toBe("end_turn");
    // The app continues the chat on its own, with its own text as the user message.
    const second = await runAgent(config(w), { sessionId: first.sessionId, attended: false, userMessage: OWN }, w.deps);
    expect(second.sessionId).toBe(first.sessionId);
    const session = (await w.storage.sessions.get(first.sessionId)) as SessionRecord;
    expect(session.attended).toBe(true);
    expect(session.meta[UNATTENDED_META_KEY]).toBe(true);
    expect(typeof session.meta[UNATTENDED_AT_META_KEY]).toBe("string");
    const appText = (await w.storage.messages.list(first.sessionId)).filter((m) => m.role === "user" && m.text.includes(OWN));
    expect(appText).toHaveLength(1);
    const outcome = await reviewCiting(w, session, appText[0] as MessageRecord);
    expect(outcome.applied).toEqual([]);
    expect(outcome.proposals).toHaveLength(1);
    expect(await entries(w, "user")).toEqual([]);
  });
});
