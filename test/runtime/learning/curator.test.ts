/** The curator: stale and archived flags at the exact boundary days, pinned skills exempt, nothing deleted. */
import { describe, expect, it } from "vitest";
import { curate } from "../../../src/learning/index.js";
import type { SkillRecord } from "../../../src/types.js";
import { AGENT, DAY_MS, START, setup, type Setup } from "./helpers.js";

async function skill(s: Setup, name: string, options: { pinned?: boolean } = {}): Promise<SkillRecord> {
  return s.skills.createSkill(
    AGENT,
    { name, description: `The ${name} steps. Use it when needed.`, body: "1. Do the first thing.", ...options },
    { actor: "user:owner" },
  );
}

const at = (days: number, ms = 0) => new Date(START.getTime() + days * DAY_MS + ms);

describe("curate", () => {
  it("unused just under 14 days stays active; at exactly 14 days it is stale", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const before = await curate(s.storage, { agentId: AGENT, now: at(14, -1) });
    expect(before.changes).toEqual([]);
    expect(before.active).toEqual(["weekly-review"]);

    const report = await curate(s.storage, { agentId: AGENT, now: at(14) });
    expect(report.changes).toMatchObject([{ name: "weekly-review", from: "active", to: "stale", unusedDays: 14 }]);
    expect(report.stale).toEqual(["weekly-review"]);
    expect((await s.storage.skills.get(AGENT, "weekly-review"))?.status).toBe("stale");
  });

  it("just under 30 days stays stale; at exactly 30 days it is archived", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    await curate(s.storage, { agentId: AGENT, now: at(20) });
    const before = await curate(s.storage, { agentId: AGENT, now: at(30, -1) });
    expect(before.changes).toEqual([]);
    expect(before.stale).toEqual(["weekly-review"]);
    const report = await curate(s.storage, { agentId: AGENT, now: at(30) });
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
    const report = await curate(s.storage, { agentId: AGENT, now: at(20) });
    expect(report.changes.map((c) => [c.name, c.to])).toEqual([["unused-skill", "stale"]]);
    expect(report.active).toEqual(["used-skill"]);
    // 14 days after its last use it is stale too.
    const later = await curate(s.storage, { agentId: AGENT, now: at(24) });
    expect(later.changes.map((c) => [c.name, c.to])).toEqual([["used-skill", "stale"]]);
  });

  it("a stale skill that is used again returns to active", async () => {
    const s = await setup();
    const record = await skill(s, "weekly-review");
    await curate(s.storage, { agentId: AGENT, now: at(15) });
    expect((await s.storage.skills.get(AGENT, "weekly-review"))?.status).toBe("stale");
    await s.storage.skills.bump(record.id, "uses", at(16).toISOString());
    const report = await curate(s.storage, { agentId: AGENT, now: at(17) });
    expect(report.changes).toMatchObject([{ name: "weekly-review", from: "stale", to: "active" }]);
    expect((await s.storage.skills.get(AGENT, "weekly-review"))?.status).toBe("active");
  });

  it("pinned skills are exempt, however old", async () => {
    const s = await setup();
    await skill(s, "pinned-skill", { pinned: true });
    const report = await curate(s.storage, { agentId: AGENT, now: at(400) });
    expect(report.changes).toEqual([]);
    expect(report.exempt).toEqual(["pinned-skill"]);
    expect(report.active).toEqual(["pinned-skill"]);
    expect((await s.storage.skills.get(AGENT, "pinned-skill"))?.status).toBe("active");
  });

  it("every status change writes an audit entry; nothing is ever deleted and the versions are intact", async () => {
    const s = await setup();
    const a = await skill(s, "skill-a");
    const b = await skill(s, "skill-b");
    await s.skills.patchSkill({ agentId: AGENT, name: "skill-a" }, { change: "patch", old: "first thing", new: "first step" }, {
      actor: "user:owner",
    });
    const versionsBefore = {
      a: await s.storage.skills.versions(a.id),
      b: await s.storage.skills.versions(b.id),
    };
    expect(versionsBefore.a).toHaveLength(2);

    await curate(s.storage, { agentId: AGENT, now: at(14) });
    await curate(s.storage, { agentId: AGENT, now: at(30) });

    const audit = await s.storage.audit.list({ action: "skill.status" });
    expect(audit).toHaveLength(4);
    for (const entry of audit) expect(entry.details).toMatchObject({ by: "curator" });
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

  it("dry run reports what would change and writes nothing", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    const auditBefore = await s.storage.audit.list();
    const report = await curate(s.storage, { agentId: AGENT, now: at(31), dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.changes).toMatchObject([{ name: "weekly-review", from: "active", to: "archived" }]);
    expect(report.archived).toEqual(["weekly-review"]);
    expect((await s.storage.skills.get(AGENT, "weekly-review"))?.status).toBe("active");
    expect(await s.storage.audit.list()).toEqual(auditBefore);
  });

  it("thresholds are configurable and validated; other agents' skills are not touched", async () => {
    const s = await setup();
    await skill(s, "weekly-review");
    await s.storage.agents.upsert({ id: "agent-2", name: "Other" });
    await s.skills.createSkill("agent-2", { name: "other-skill", description: "Other steps. Use it.", body: "1. Go." }, { actor: "user:owner" });
    const report = await curate(s.storage, { agentId: AGENT, now: at(3), staleDays: 2, archiveDays: 5 });
    expect(report.changes.map((c) => [c.name, c.to])).toEqual([["weekly-review", "stale"]]);
    expect(report.checked).toBe(1);
    expect((await s.storage.skills.get("agent-2", "other-skill"))?.status).toBe("active");
    await expect(curate(s.storage, { agentId: AGENT, now: at(3), staleDays: 0 })).rejects.toThrow(TypeError);
    await expect(curate(s.storage, { agentId: AGENT, now: at(3), staleDays: 10, archiveDays: 5 })).rejects.toThrow(TypeError);
    await expect(curate(s.storage, { agentId: AGENT, now: new Date(Number.NaN) })).rejects.toThrow(TypeError);
  });
});
