/**
 * Review fix C6 (STORE block): SkillService.patchSkill writes with a compare-and-set on the skill's version, so two
 * concurrent approvals of different patches to one skill both land (the second is computed again on a fresh read)
 * instead of the second silently overwriting the first. Runs on every adapter (Postgres when
 * HERMOD_TEST_DATABASE_URL is set).
 */
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryService } from "../../../src/memory/index.js";
import { ProposalService } from "../../../src/proposals/index.js";
import { SkillConflictError, SkillService } from "../../../src/skills/index.js";
import {
  createMemoryStorage,
  createPostgresStorage,
  createSqliteStorage,
  fromPostgresJs,
  validatePostgresSchema,
} from "../../../src/storage/index.js";
import type { SkillChange, Storage } from "../../../src/types.js";

const AGENT = "agent-1";
const OWNER = "user:owner";
const BODY = "1. Build.\n2. Test.\n3. Ship.";

type Make = () => Promise<{ storage: Storage; cleanup: () => Promise<void> }>;

const adapters: Array<[string, Make]> = [
  ["memory", async () => ({ storage: createMemoryStorage(), cleanup: async () => {} })],
  [
    "sqlite",
    async () => {
      const db = new Database(":memory:");
      return { storage: createSqliteStorage(db), cleanup: async () => void db.close() };
    },
  ],
];

const DATABASE_URL = process.env.HERMOD_TEST_DATABASE_URL;
if (DATABASE_URL) {
  const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  const exec = fromPostgresJs(sql);
  const run = `hermod_rs${randomBytes(4).toString("hex")}`;
  let counter = 0;
  afterAll(async () => {
    const left = await sql.unsafe(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`${run}%`]);
    for (const row of left) await sql.unsafe(`DROP SCHEMA IF EXISTS "${validatePostgresSchema(String(row.nspname))}" CASCADE`);
    await sql.end();
  });
  adapters.push([
    "postgres",
    async () => {
      const schema = `${run}_${++counter}`;
      return {
        storage: createPostgresStorage(exec, { schema }),
        cleanup: async () => void (await sql.unsafe(`DROP SCHEMA IF EXISTS "${validatePostgresSchema(schema)}" CASCADE`)),
      };
    },
  ]);
}

/**
 * A storage whose skills.get waits until `readers` reads have started, so concurrent patches all read the same
 * version before any of them writes (the race, made deterministic).
 */
function barrierOnRead(storage: Storage, readers: number): Storage {
  let waiting: Array<() => void> = [];
  let armed = true;
  return {
    ...storage,
    skills: {
      ...storage.skills,
      get: async (agentId, name) => {
        const row = await storage.skills.get(agentId, name);
        if (armed) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length >= readers) {
              armed = false;
              for (const go of waiting) go();
              waiting = [];
            }
          });
        }
        return row;
      },
    },
  };
}

async function world(make: Make, readers = 2) {
  const made = await make();
  await made.storage.migrate();
  await made.storage.agents.upsert({ id: AGENT, name: "Helper", mode: "autonomous" });
  const plain = new SkillService({ storage: made.storage });
  await plain.createSkill(AGENT, { name: "release", description: "Release steps. Use it to ship.", body: BODY }, { actor: OWNER });
  const racing = barrierOnRead(made.storage, readers);
  return { ...made, plain, racing, skills: new SkillService({ storage: racing }) };
}

const patch = (old: string, next: string): SkillChange => ({ change: "patch", old, new: next });

describe.each(adapters)("C6: concurrent skill patches keep both changes (%s)", (_name, make) => {
  it("two concurrent patches of different lines both land, each as its own version", async () => {
    const w = await world(make);
    try {
      const ref = { agentId: AGENT, name: "release" };
      await Promise.all([
        w.skills.patchSkill(ref, patch("1. Build.", "1. Build with the lockfile."), { actor: OWNER, proposalId: "p-1" }),
        w.skills.patchSkill(ref, patch("3. Ship.", "3. Ship and tag."), { actor: OWNER, proposalId: "p-2" }),
      ]);
      const current = await w.storage.skills.get(AGENT, "release");
      expect(current?.body).toBe("1. Build with the lockfile.\n2. Test.\n3. Ship and tag.");
      expect(current?.version).toBe(3);
      const versions = await w.storage.skills.versions(current!.id);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(versions[2]?.body).toBe(current?.body);
      expect(current?.counters.patches).toBe(2);
      const audit = await w.storage.audit.list({ action: "skill.patch" });
      expect(audit.map((e) => e.details["version"]).sort()).toEqual([2, 3]);
      expect(versions.slice(1).map((v) => v.proposalId).sort()).toEqual(["p-1", "p-2"]);
    } finally {
      await w.cleanup();
    }
  });

  it("a patch whose text the other patch removed fails with patch_not_found instead of undoing it", async () => {
    const w = await world(make);
    try {
      const ref = { agentId: AGENT, name: "release" };
      const results = await Promise.allSettled([
        w.skills.patchSkill(ref, patch("2. Test.", "2. Run the full suite."), { actor: OWNER }),
        w.skills.patchSkill(ref, patch("2. Test.", "2. Test on staging."), { actor: OWNER }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ name: "SkillError", code: "patch_not_found" });
      const current = await w.storage.skills.get(AGENT, "release");
      expect(current?.version).toBe(2);
      expect(["1. Build.\n2. Run the full suite.\n3. Ship.", "1. Build.\n2. Test on staging.\n3. Ship."]).toContain(current?.body);
      expect(await w.storage.skills.versions(current!.id)).toHaveLength(2);
    } finally {
      await w.cleanup();
    }
  });

  it("two approvals of different patch proposals to one skill both apply", async () => {
    const w = await world(make);
    try {
      const memory = new MemoryService({ storage: w.racing });
      const proposals = new ProposalService({ storage: w.racing, memory, skills: w.skills });
      const create = (old: string, next: string) =>
        w.storage.proposals.create({
          agentId: AGENT,
          kind: "skill",
          target: "release",
          payload: { kind: "skill", skill: "release", changes: [patch(old, next)] },
          evidence: [{ kind: "test", ref: "release-check" }],
          rationale: "Seen in the last release.",
          sessionId: null,
          createdBy: "review",
        });
      const one = await create("1. Build.", "1. Build clean.");
      const two = await create("3. Ship.", "3. Ship to production.");
      const decided = await Promise.all([proposals.approve(one.id, OWNER), proposals.approve(two.id, OWNER)]);
      expect(decided.map((p) => p?.status)).toEqual(["applied", "applied"]);
      expect((await w.storage.skills.get(AGENT, "release"))?.body).toBe("1. Build clean.\n2. Test.\n3. Ship to production.");
    } finally {
      await w.cleanup();
    }
  });
});

describe("C6: a skill that keeps moving", () => {
  it("is reported as a conflict after one retry, and nothing is written by the refused change", async () => {
    const base = createMemoryStorage();
    await base.agents.upsert({ id: AGENT, name: "Helper", mode: "autonomous" });
    await new SkillService({ storage: base }).createSkill(
      AGENT,
      { name: "release", description: "Release steps. Use it to ship.", body: BODY },
      { actor: OWNER },
    );
    let updates = 0;
    // Every write sees a version that moved since the read (another writer always lands first).
    const storage: Storage = {
      ...base,
      skills: {
        ...base.skills,
        update: async (id, change, meta, expectedVersion) => {
          updates += 1;
          return base.skills.update(id, change, meta, expectedVersion + 1);
        },
      },
    };
    const skills = new SkillService({ storage });
    const patching = skills.patchSkill({ agentId: AGENT, name: "release" }, patch("3. Ship.", "3. Ship it."), { actor: OWNER });
    await expect(patching).rejects.toBeInstanceOf(SkillConflictError);
    await expect(
      skills.patchSkill({ agentId: AGENT, name: "release" }, patch("3. Ship.", "3. Ship it."), { actor: OWNER }),
    ).rejects.toMatchObject({ code: "conflict", skill: "release" });
    expect(updates).toBe(4); // one write and one retry per call
    const current = await base.skills.get(AGENT, "release");
    expect(current).toMatchObject({ version: 1, body: BODY, counters: { patches: 0 } });
    expect(await base.audit.list({ action: "skill.patch" })).toEqual([]);
  });

  it("reports not_found when the skill disappears between the read and the write", async () => {
    const base = createMemoryStorage();
    await base.agents.upsert({ id: AGENT, name: "Helper", mode: "autonomous" });
    await new SkillService({ storage: base }).createSkill(
      AGENT,
      { name: "release", description: "Release steps. Use it to ship.", body: BODY },
      { actor: OWNER },
    );
    let reads = 0;
    const storage: Storage = {
      ...base,
      skills: {
        ...base.skills,
        get: async (agentId, name) => (++reads <= 2 ? base.skills.get(agentId, name) : null),
        update: async () => null,
      },
    };
    await expect(
      new SkillService({ storage }).patchSkill({ agentId: AGENT, name: "release" }, patch("3. Ship.", "3. Go."), { actor: OWNER }),
    ).rejects.toMatchObject({ name: "SkillError", code: "not_found" });
  });
});
