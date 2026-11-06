/** Modes: audited changes by a person only, draft scoring, shadow stats, the bar, and no automatic promotion. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMALL_EDIT_WEIGHT,
  ModeError,
  getMode,
  meetsBar,
  scoreDraft,
  setMode,
  shadowStats,
} from "../../../src/modes/index.js";
import type { DraftScore, ProposalRecord } from "../../../src/types.js";
import { AGENT, setup, type Setup } from "./helpers.js";

const OWNER = "user:owner";

async function draft(s: Setup, options: { shadow?: boolean; kind?: "action" | "memory"; agentId?: string } = {}): Promise<ProposalRecord> {
  const kind = options.kind ?? "action";
  s.tick();
  return s.storage.proposals.create({
    agentId: options.agentId ?? AGENT,
    sessionId: null,
    kind,
    target: kind === "action" ? "send_reply" : "user",
    payload:
      kind === "action"
        ? { kind: "action", tool: "send_reply", input: { text: "Draft reply" }, draftText: "Draft reply" }
        : { kind: "memory", store: "user", ops: [{ op: "add", text: "User likes tea." }] },
    evidence: [{ kind: "log", ref: "draft" }],
    rationale: "A draft.",
    createdBy: `agent:${AGENT}`,
    shadow: options.shadow ?? true,
  });
}

async function scored(s: Setup, scores: DraftScore[]): Promise<void> {
  for (const score of scores) {
    const p = await draft(s);
    await scoreDraft(s.proposals, p.id, score, OWNER);
  }
}

describe("getMode / setMode", () => {
  it("a person changes the mode; the change is audited with from and to", async () => {
    const s = await setup("shadow");
    expect(await getMode(s.storage, AGENT)).toBe("shadow");
    const updated = await setMode(s.storage, AGENT, "supervised", OWNER, { note: "Bar met.", now: s.now });
    expect(updated.mode).toBe("supervised");
    expect(await getMode(s.storage, AGENT)).toBe("supervised");
    const audit = await s.storage.audit.list({ action: "agent.mode" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: OWNER,
      target: `agent:${AGENT}`,
      details: { from: "shadow", to: "supervised", note: "Bar met." },
    });
  });

  it("setting the same mode writes nothing", async () => {
    const s = await setup("shadow");
    await setMode(s.storage, AGENT, "shadow", OWNER);
    expect(await s.storage.audit.list({ action: "agent.mode" })).toEqual([]);
  });

  it("validates the mode and refuses an unknown agent, writing nothing", async () => {
    const s = await setup("shadow");
    for (const bad of ["Autonomous", "on", "", null, 1]) {
      await expect(setMode(s.storage, AGENT, bad as never, OWNER)).rejects.toMatchObject({ code: "invalid_mode" });
    }
    await expect(setMode(s.storage, "nobody", "autonomous", OWNER)).rejects.toMatchObject({ code: "not_found" });
    await expect(getMode(s.storage, "nobody")).rejects.toBeInstanceOf(ModeError);
    expect(await getMode(s.storage, AGENT)).toBe("shadow");
    expect(await s.storage.audit.list()).toEqual([]);
  });

  it("an agent, the reviewer, a job or the system can never change a mode", async () => {
    const s = await setup("shadow");
    for (const actor of [`agent:${AGENT}`, "agent", "review", "job:nightly", "system", "curator", "scheduler", "", "  "]) {
      await expect(setMode(s.storage, AGENT, "autonomous", actor)).rejects.toMatchObject({ code: "not_allowed" });
    }
    expect(await getMode(s.storage, AGENT)).toBe("shadow");
    expect(await s.storage.audit.list({ action: "agent.mode" })).toEqual([]);
  });
});

describe("scoreDraft", () => {
  it("a person scores a shadow draft or an action proposal; the score is stored and audited", async () => {
    const s = await setup("shadow");
    const shadowDraft = await draft(s, { kind: "memory", shadow: true });
    const action = await draft(s, { kind: "action", shadow: false });
    expect((await scoreDraft(s.proposals, shadowDraft.id, "as_is", OWNER))?.score).toBe("as_is");
    expect((await scoreDraft(s.proposals, action.id, "wrong", OWNER))?.score).toBe("wrong");
    const audit = await s.storage.audit.list({ action: "proposal.score" });
    expect(audit).toHaveLength(2);
    for (const entry of audit) expect(entry.actor).toBe(OWNER);
  });

  it("refuses a proposal that is not a draft, a bad score and a non-human scorer", async () => {
    const s = await setup("shadow");
    const memory = await draft(s, { kind: "memory", shadow: false });
    await expect(scoreDraft(s.proposals, memory.id, "as_is", OWNER)).rejects.toMatchObject({ code: "not_a_draft" });
    const action = await draft(s);
    await expect(scoreDraft(s.proposals, action.id, "great" as never, OWNER)).rejects.toMatchObject({ code: "invalid_score" });
    await expect(scoreDraft(s.proposals, action.id, "as_is", "review")).rejects.toMatchObject({ code: "not_allowed" });
    await expect(scoreDraft(s.proposals, action.id, "as_is", `agent:${AGENT}`)).rejects.toMatchObject({ code: "not_allowed" });
    expect((await s.storage.proposals.get(action.id))?.score).toBeNull();
    expect((await s.storage.proposals.get(memory.id))?.score).toBeNull();
    expect(await s.storage.audit.list({ action: "proposal.score" })).toEqual([]);
    expect(await scoreDraft(s.proposals, "missing", "as_is", OWNER)).toBeNull();
  });
});

describe("shadowStats", () => {
  it("accuracy = (asIs + 0.5 × smallEdit) / n, counting scored drafts only", async () => {
    const s = await setup("shadow");
    await scored(s, ["as_is", "as_is", "as_is", "small_edit", "small_edit", "wrong"]);
    await draft(s); // not scored: not counted
    await draft(s, { kind: "memory", shadow: false }); // not a draft
    await s.storage.agents.upsert({ id: "agent-2", name: "Other" });
    const other = await draft(s, { agentId: "agent-2" });
    await scoreDraft(s.proposals, other.id, "wrong", OWNER); // another agent's draft: not counted
    const stats = await shadowStats(s.storage, AGENT);
    expect(DEFAULT_SMALL_EDIT_WEIGHT).toBe(0.5);
    expect(stats).toMatchObject({ n: 6, asIs: 3, smallEdit: 2, wrong: 1, smallEditWeight: 0.5 });
    expect(stats.accuracy).toBeCloseTo((3 + 0.5 * 2) / 6, 12);
  });

  it("the small-edit weight is configurable and validated", async () => {
    const s = await setup("shadow");
    await scored(s, ["as_is", "small_edit", "small_edit", "wrong"]);
    expect((await shadowStats(s.storage, AGENT, { smallEditWeight: 1 })).accuracy).toBeCloseTo(3 / 4, 12);
    expect((await shadowStats(s.storage, AGENT, { smallEditWeight: 0 })).accuracy).toBeCloseTo(1 / 4, 12);
    expect((await shadowStats(s.storage, AGENT, { smallEditWeight: 0.25 })).accuracy).toBeCloseTo(1.5 / 4, 12);
    await expect(shadowStats(s.storage, AGENT, { smallEditWeight: 1.5 })).rejects.toThrow(TypeError);
    await expect(shadowStats(s.storage, AGENT, { smallEditWeight: -0.1 })).rejects.toThrow(TypeError);
  });

  it("window counts only the newest scored drafts", async () => {
    const s = await setup("shadow");
    await scored(s, ["wrong", "wrong", "as_is", "as_is", "small_edit"]);
    const recent = await shadowStats(s.storage, AGENT, { window: 3 });
    expect(recent).toMatchObject({ n: 3, asIs: 2, smallEdit: 1, wrong: 0 });
    expect(recent.accuracy).toBeCloseTo(2.5 / 3, 12);
    expect((await shadowStats(s.storage, AGENT, { window: 100 })).n).toBe(5);
    await expect(shadowStats(s.storage, AGENT, { window: 0 })).rejects.toThrow(TypeError);
  });

  it("no scored drafts: n 0 and accuracy 0", async () => {
    const s = await setup("shadow");
    expect(await shadowStats(s.storage, AGENT)).toMatchObject({ n: 0, asIs: 0, smallEdit: 0, wrong: 0, accuracy: 0 });
  });
});

describe("meetsBar", () => {
  const agent = { accuracyBar: 0.9, minSamples: 20 };

  it("needs at least minSamples drafts AND accuracy at or above the bar (both boundaries inclusive)", () => {
    expect(meetsBar({ n: 20, accuracy: 0.9 }, agent)).toBe(true);
    expect(meetsBar({ n: 19, accuracy: 1 }, agent)).toBe(false);
    expect(meetsBar({ n: 20, accuracy: 0.8999 }, agent)).toBe(false);
    expect(meetsBar({ n: 500, accuracy: 0.95 }, agent)).toBe(true);
  });

  it("zero samples never meet a bar, even with minSamples 0; a broken bar never meets", () => {
    expect(meetsBar({ n: 0, accuracy: 0 }, { accuracyBar: 0, minSamples: 0 })).toBe(false);
    expect(meetsBar({ n: 1, accuracy: 1 }, { accuracyBar: Number.NaN, minSamples: 1 })).toBe(false);
  });

  it("works on real stats and the stored agent, and never changes the mode", async () => {
    const s = await setup("shadow");
    await s.storage.agents.update(AGENT, { accuracyBar: 0.75, minSamples: 4 });
    await scored(s, ["as_is", "as_is", "small_edit", "as_is"]); // (3 + 0.5) / 4 = 0.875
    const record = await s.storage.agents.get(AGENT);
    if (!record) throw new Error("no agent");
    const stats = await shadowStats(s.storage, AGENT);
    expect(meetsBar(stats, record)).toBe(true);
    expect(await getMode(s.storage, AGENT)).toBe("shadow");
    expect(await s.storage.audit.list({ action: "agent.mode" })).toEqual([]);
  });
});

describe("no automatic promotion", () => {
  const root = fileURLToPath(new URL("../../../src/", import.meta.url));

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...files(path));
      else if (/\.(?:ts|mts|js|mjs)$/.test(name)) out.push(path);
    }
    return out;
  }

  /** Code without comments and strings would be ideal; comments are stripped so a doc mention is not a call. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  }

  it("nothing in src/ calls setMode or writes an agent's mode outside src/modes/modes.ts", () => {
    const all = files(root);
    expect(all.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const path of all) {
      const rel = relative(root, path).split(sep).join("/");
      if (rel === "modes/modes.ts") continue;
      const text = code(readFileSync(path, "utf8"));
      if (/\bsetMode\s*\(/.test(text)) offenders.push(`${rel}: calls setMode`);
      if (/\.agents\s*\.\s*update\s*\(/.test(text)) offenders.push(`${rel}: calls agents.update`);
    }
    expect(offenders).toEqual([]);
  });

  it("the grep would catch a call (self-check)", () => {
    expect(/\bsetMode\s*\(/.test(code("await setMode(storage, id, 'autonomous', 'x');"))).toBe(true);
    expect(/\bsetMode\s*\(/.test(code("// setMode(storage) is the only way"))).toBe(false);
    expect(/\.agents\s*\.\s*update\s*\(/.test(code("storage.agents.update(id, { mode })"))).toBe(true);
  });
});
