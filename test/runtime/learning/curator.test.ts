/**
 * The curator: stale and archived flags at the exact boundary days, pinned skills exempt, nothing deleted.
 *
 * The agent only proposes: curate() only reports and never writes. A person applies a report with applyCuration(),
 * which refuses Hermod's own actors, skips changes the skill has moved past, and audits each change it makes.
 */
import { describe, expect, it } from "vitest";
import { CurationError, applyCuration, curate } from "../../../src/learning/index.js";
import type { CuratorReport } from "../../../src/learning/index.js";
import { AgentOffError } from "../../../src/types.js";
import type { SkillRecord, Storage } from "../../../src/types.js";
import { AGENT, DAY_MS, START, setup, type Setup } from "./helpers.js";

const OWNER = "user:owner";

async function skill(s: Setup, name: string, options: { pinned?: boolean } = {}): Promise<SkillRecord> {
  return s.skills.createSkill(
    AGENT,
    { name, description: `The ${name} steps. Use it when needed.`, body: "1. Do the first thing.", ...options },
    { actor: OWNER },
  );
}

const at = (days: number, ms = 0) => new Date(START.getTime() + days * DAY_MS + ms);

async function status(s: Setup, name: string): Promise<string | undefined> {
  return (await s.storage.skills.get(AGENT, name))?.status;
}

/** Reports, then applies the report as the owner (what a person does). */
async function curateAndApply(s: Setup, now: Date): Promise<CuratorReport> {
  const report = await curate(s.storage, { agentId: AGENT, now });
  await applyCuration(s.storage, report, OWNER, { now: () => now });
  return report;
}

/** Every skill and audit row, to prove that nothing was written. */
async function snapshot(storage: Storage): Promise<unknown> {
  const skills = [...(await storage.skills.list(AGENT)), ...(await storage.skills.list(AGENT, { status: "archived" }))];
  return { skills: [...new Map(skills.map((x) => [x.id, x])).values()], audit: await storage.audit.list() };
}

describe("curate (report only)", () => {
  it("unused just under 14 days stays active; at exactly 14 days it is reported stale", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const before = await curate(s.storage, { agentId: AGENT, now: at(14, -1) });
    expect(before.changes).toEqual([]);
    expect(before.active).toEqual(["weekly-review"]);

    const report = await curate(s.storage, { agentId: AGENT, now: at(14) });
    expect(report.changes).toMatchObject([{ name: "weekly-review", from: "active", to: "stale", unusedDays: 14, lastUsedAt: null }]);
    expect(report.stale).toEqual(["weekly-review"]);
    expect(report.active).toEqual([]);
    // Only reported: the skill is unchanged until a person applies the report.
    expect(await status(s, "weekly-review")).toBe("active");
    await applyCuration(s.storage, report, OWNER);
    expect(await status(s, "weekly-review")).toBe("stale");
  });

  it("just under 30 days stays stale; at exactly 30 days it is archived", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    await curateAndApply(s, at(20));
    const before = await curate(s.storage, { agentId: AGENT, now: at(30, -1) });
    expect(before.changes).toEqual([]);
    expect(before.stale).toEqual(["weekly-review"]);
    const report = await curateAndApply(s, at(30));
    expect(report.changes).toMatchObject([{ name: "weekly-review", from: "stale", to: "archived" }]);
    expect(report.archived).toEqual(["weekly-review"]);
    const list = await s.storage.skills.list(AGENT, { status: "archived" });
    expect(list.map((x) => x.name)).toEqual(["weekly-review"]);
  });

  it("an active skill unused for 30+ days goes straight to archived", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const report = await curate(s.storage, { agentId: AGENT, now: at(45) });
    expect(report.changes).toMatchObject([{ from: "active", to: "archived" }]);
  });

  it("measures from lastUsedAt when the skill was used, else from createdAt", async () => {
    const s = await setup();
    const used = await skill(s, "used-skill");
    await skill(s, "unused-skill");
    await s.storage.skills.bump(used.id, "uses", at(10).toISOString());
    const report = await curateAndApply(s, at(20));
    expect(report.changes.map((c) => [c.name, c.to])).toEqual([["unused-skill", "stale"]]);
    expect(report.active).toEqual(["used-skill"]);
    // 14 days after its last use it is stale too.
    const later = await curate(s.storage, { agentId: AGENT, now: at(24) });
    expect(later.changes.map((c) => [c.name, c.to, c.lastUsedAt])).toEqual([["used-skill", "stale", at(10).toISOString()]]);
  });

  it("a stale skill that is used again is reported active", async () => {
    const s = await setup();
    const record = await skill(s, "weekly-review");
    await curateAndApply(s, at(15));
    expect(await status(s, "weekly-review")).toBe("stale");
    await s.storage.skills.bump(record.id, "uses", at(16).toISOString());
    const report = await curateAndApply(s, at(17));
    expect(report.changes).toMatchObject([{ name: "weekly-review", from: "stale", to: "active" }]);
    expect(await status(s, "weekly-review")).toBe("active");
  });

  it("pinned skills are exempt, however old", async () => {
    const s = await setup();
    await skill(s, "pinned-skill", { pinned: true });
    const report = await curate(s.storage, { agentId: AGENT, now: at(400) });
    expect(report.changes).toEqual([]);
    expect(report.exempt).toEqual(["pinned-skill"]);
    expect(report.active).toEqual(["pinned-skill"]);
    expect(await status(s, "pinned-skill")).toBe("active");
  });

  it("never writes anything: no status change, no audit entry, also with the old dryRun flag either way", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    await skill(s, "monthly-review");
    const before = await snapshot(s.storage);
    for (const dryRun of [undefined, false, true]) {
      const report = await curate(s.storage, { agentId: AGENT, now: at(31), ...(dryRun === undefined ? {} : { dryRun }) });
      expect(report.changes.map((c) => [c.name, c.from, c.to])).toEqual([
        ["monthly-review", "active", "archived"],
        ["weekly-review", "active", "archived"],
      ]);
      expect(report.archived).toEqual(["monthly-review", "weekly-review"]);
    }
    expect(await snapshot(s.storage)).toEqual(before);
  });

  it("thresholds are configurable and validated; other agents' skills are not touched", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    await s.storage.agents.upsert({ id: "agent-2", name: "Other" });
    await s.skills.createSkill("agent-2", { name: "other-skill", description: "Other steps. Use it.", body: "1. Go." }, { actor: OWNER });
    const report = await curate(s.storage, { agentId: AGENT, now: at(3), staleDays: 2, archiveDays: 5 });
    expect(report.changes.map((c) => [c.name, c.to])).toEqual([["weekly-review", "stale"]]);
    expect(report.checked).toBe(1);
    await applyCuration(s.storage, report, OWNER);
    expect((await s.storage.skills.get("agent-2", "other-skill"))?.status).toBe("active");
    await expect(curate(s.storage, { agentId: AGENT, now: at(3), staleDays: 0 })).rejects.toThrow(TypeError);
    await expect(curate(s.storage, { agentId: AGENT, now: at(3), staleDays: 10, archiveDays: 5 })).rejects.toThrow(TypeError);
    await expect(curate(s.storage, { agentId: AGENT, now: new Date(Number.NaN) })).rejects.toThrow(TypeError);
  });
});

describe("applyCuration (a person applies the report)", () => {
  it("every status change writes an audit entry under the person's name; nothing is deleted and versions are intact", async () => {
    const s = await setup();
    const a = await skill(s, "skill-a");
    const b = await skill(s, "skill-b");
    await s.skills.patchSkill({ agentId: AGENT, name: "skill-a" }, { change: "patch", old: "first thing", new: "first step" }, {
      actor: OWNER,
    });
    const versionsBefore = {
      a: await s.storage.skills.versions(a.id),
      b: await s.storage.skills.versions(b.id),
    };
    expect(versionsBefore.a).toHaveLength(2);

    const first = await curate(s.storage, { agentId: AGENT, now: at(14) });
    const result = await applyCuration(s.storage, first, ` ${OWNER} `, { now: () => at(14, 5), note: "spring clean" });
    expect(result).toMatchObject({ agentId: AGENT, by: OWNER, skipped: [] });
    expect(result.applied.map((c) => c.name)).toEqual(["skill-a", "skill-b"]);
    await curateAndApply(s, at(30));

    const audit = await s.storage.audit.list({ action: "skill.status" });
    expect(audit).toHaveLength(4);
    for (const entry of audit) {
      expect(entry.actor).toBe(OWNER);
      expect(entry.details).toMatchObject({ source: "curator" });
    }
    expect(audit.filter((e) => e.details["note"] === "spring clean")).toHaveLength(2);
    expect(audit.filter((e) => e.at === at(14, 5).toISOString())).toHaveLength(2);
    expect(audit.map((e) => [e.details["from"], e.details["to"]]).sort()).toEqual([
      ["active", "stale"],
      ["active", "stale"],
      ["stale", "archived"],
      ["stale", "archived"],
    ]);
    expect(await s.storage.skills.versions(a.id)).toEqual(versionsBefore.a);
    expect(await s.storage.skills.versions(b.id)).toEqual(versionsBefore.b);
    const all = [...(await s.storage.skills.list(AGENT)), ...(await s.storage.skills.list(AGENT, { status: "archived" }))];
    const unique = new Map(all.map((x) => [x.id, x]));
    expect(unique.size).toBe(2);
    for (const x of unique.values()) {
      expect(x.status).toBe("archived");
      expect(x.body).toBeTruthy();
    }
    expect([...unique.values()].find((x) => x.name === "skill-a")?.version).toBe(2);
    // An archived skill stays archived: a person restores it.
    const again = await curate(s.storage, { agentId: AGENT, now: at(60) });
    expect(again.changes).toEqual([]);
  });

  it("refuses Hermod's own actors (any case, look-alikes too) and an empty actor, before writing anything", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const report = await curate(s.storage, { agentId: AGENT, now: at(40) });
    const before = await snapshot(s.storage);
    const actors = ["system", "curator", "agent", "agent:notes", "Job:daily", " REVIEW ", "scheduler", "delegate:x", "ｓｙｓｔｅｍ", "", "  "];
    for (const by of [...actors, undefined, 42]) {
      const refused = applyCuration(s.storage, report, by as string);
      await expect(refused).rejects.toBeInstanceOf(CurationError);
      await expect(applyCuration(s.storage, report, by as string)).rejects.toMatchObject({ code: "not_allowed" });
    }
    expect(await snapshot(s.storage)).toEqual(before);
  });

  it("refuses a report with a change the curator never makes, before writing anything", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const archived = await skill(s, "old-skill");
    await s.storage.skills.setStatus(archived.id, "archived");
    const report = await curate(s.storage, { agentId: AGENT, now: at(40) });
    const before = await snapshot(s.storage);
    const forged: CuratorReport = {
      ...report,
      changes: [
        ...report.changes,
        { skillId: archived.id, name: "old-skill", from: "archived", to: "active", unusedDays: 40, lastUsedAt: null },
      ],
    };
    await expect(applyCuration(s.storage, forged, OWNER)).rejects.toMatchObject({ code: "invalid_report" });
    for (const bad of [null, {}, { ...report, agentId: "" }, { ...report, changes: "all" }, { ...report, changes: [null] }]) {
      await expect(applyCuration(s.storage, bad as CuratorReport, OWNER)).rejects.toBeInstanceOf(CurationError);
    }
    expect(await snapshot(s.storage)).toEqual(before);
  });

  it("skips a change whose skill moved since the report: used again, pinned, or already changed", async () => {
    const s = await setup();
    const used = await skill(s, "used-again");
    const pinned = await skill(s, "pinned-later");
    const moved = await skill(s, "moved");
    await skill(s, "still-unused");
    const report = await curate(s.storage, { agentId: AGENT, now: at(20) });
    expect(report.changes.map((c) => c.name)).toEqual(["moved", "pinned-later", "still-unused", "used-again"]);
    await s.storage.skills.bump(used.id, "uses", at(20, 1).toISOString());
    await s.storage.skills.setPinned(pinned.id, true);
    await s.storage.skills.setStatus(moved.id, "archived");

    const result = await applyCuration(s.storage, report, OWNER);
    expect(result.applied.map((c) => c.name)).toEqual(["still-unused"]);
    expect(result.skipped.map((x) => [x.change.name, x.reason])).toEqual([
      ["moved", "the skill is archived now, not active"],
      ["pinned-later", "the skill is pinned now"],
      ["used-again", "the skill was used after the report"],
    ]);
    expect(await status(s, "used-again")).toBe("active");
    expect(await status(s, "pinned-later")).toBe("active");
    expect(await status(s, "still-unused")).toBe("stale");
    expect(await s.storage.audit.list({ action: "skill.status" })).toHaveLength(1);
    // Applying the same report again changes nothing more.
    const twice = await applyCuration(s.storage, report, OWNER);
    expect(twice.applied).toEqual([]);
    expect(await s.storage.audit.list({ action: "skill.status" })).toHaveLength(1);
  });

  it("does nothing for an agent that is off, and a missing agent is a programming error", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const report = await curate(s.storage, { agentId: AGENT, now: at(40) });
    await s.storage.agents.update(AGENT, { mode: "off" });
    const before = await snapshot(s.storage);
    await expect(applyCuration(s.storage, report, OWNER)).rejects.toBeInstanceOf(AgentOffError);
    expect(await snapshot(s.storage)).toEqual(before);
    await expect(applyCuration(s.storage, { ...report, agentId: "no-such-agent" }, OWNER)).rejects.toThrow(
      new TypeError('applyCuration: there is no agent "no-such-agent".'),
    );
  });
});
