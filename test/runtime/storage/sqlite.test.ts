import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteStorage, ftsQuery, searchTerms, type SqliteDatabase } from "../../../src/storage/index.js";
import type { Storage } from "../../../src/types.js";
import { runStorageConformance } from "../storage-conformance.js";

runStorageConformance("SQLite (better-sqlite3, in memory)", async ({ now }) => {
  const db = new Database(":memory:");
  return { storage: createSqliteStorage(db, { now }), cleanup: async () => void db.close() };
});

runStorageConformance("SQLite (file, WAL, custom prefix)", async ({ now }) => {
  const dir = mkdtempSync(join(tmpdir(), "hermod-sqlite-"));
  const db = new Database(join(dir, "app.db"));
  db.pragma("journal_mode = WAL");
  return {
    storage: createSqliteStorage(db, { now, prefix: "app_hermod_" }),
    cleanup: async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

const session = (storage: Storage, agentId = "agent-a") =>
  storage.sessions.create({ agentId, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });

describe("SQLite adapter specifics", () => {
  const open: Array<{ close(): unknown }> = [];
  const dirs: string[] = [];
  const memoryDb = () => {
    const db = new Database(":memory:");
    open.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a better-sqlite3 Database fits the structural SqliteDatabase type", () => {
    const db: SqliteDatabase = memoryDb();
    expect(typeof db.prepare).toBe("function");
  });

  it("records each migration version once in <prefix>migrations", async () => {
    const db = memoryDb();
    const storage = createSqliteStorage(db);
    await storage.migrate();
    await storage.migrate();
    await createSqliteStorage(db).migrate();
    const rows = db.prepare('SELECT version, name FROM "hermod_migrations"').all();
    expect(rows).toEqual([{ version: 1, name: "initial schema" }]);
  });

  it("creates every table, index and trigger under the prefix, and FTS5 with unicode61 remove_diacritics 2", async () => {
    const db = memoryDb();
    await createSqliteStorage(db, { prefix: "x_" }).migrate();
    const names = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
      type: string;
      sql: string | null;
    }>;
    expect(names.length).toBeGreaterThan(20);
    for (const { name } of names) expect(name.startsWith("x_"), name).toBe(true);
    const fts = names.find((n) => n.name === "x_messages_fts");
    expect(fts?.sql).toContain("unicode61 remove_diacritics 2");
    expect(fts?.sql).toContain("content = 'x_messages'");
    const triggers = names.filter((n) => n.type === "trigger").map((n) => n.name);
    expect(triggers.sort()).toEqual([
      "x_audit_no_delete",
      "x_audit_no_update",
      "x_messages_fts_delete",
      "x_messages_fts_insert",
      "x_messages_fts_update",
    ]);
  });

  it("two prefixes in one database are independent stores", async () => {
    const db = memoryDb();
    const one = createSqliteStorage(db, { prefix: "one_" });
    const two = createSqliteStorage(db, { prefix: "two_" });
    await one.migrate();
    await two.migrate();
    await one.agents.upsert({ id: "a", name: "In one" });
    expect(await two.agents.get("a")).toBeNull();
    const s = await session(one);
    await one.messages.append(s.id, { role: "user", content: "rätta", text: "rätta" });
    expect(await two.messages.search("ratta")).toEqual([]);
    expect(await one.messages.search("ratta")).toHaveLength(1);
  });

  it("refuses unsafe or invalid prefixes", () => {
    const db = memoryDb();
    for (const prefix of ["", "Hermod_", "1x_", 'x"; DROP TABLE y; --', "x-y", "a".repeat(49), "x y"]) {
      expect(() => createSqliteStorage(db, { prefix }), prefix).toThrow(/prefix/);
    }
  });

  it("changes no pragmas (journal mode and foreign keys stay the app's choice)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermod-sqlite-"));
    dirs.push(dir);
    const db = new Database(join(dir, "app.db"));
    open.push(db);
    db.pragma("foreign_keys = OFF");
    const before = { journal: db.pragma("journal_mode", { simple: true }), fk: db.pragma("foreign_keys", { simple: true }) };
    const storage = createSqliteStorage(db);
    await storage.migrate();
    await storage.agents.upsert({ id: "a", name: "A" });
    expect({ journal: db.pragma("journal_mode", { simple: true }), fk: db.pragma("foreign_keys", { simple: true }) }).toEqual(
      before,
    );
    expect(before).toEqual({ journal: "delete", fk: 0 });
  });

  it("refuses to update or delete audit entries even with raw SQL", async () => {
    const db = memoryDb();
    const storage = createSqliteStorage(db);
    await storage.migrate();
    await storage.audit.append({ at: "2026-11-05T08:00:00.000Z", actor: "system", action: "x", target: "t", details: {} });
    expect(() => db.prepare(`UPDATE "hermod_audit" SET action = 'forged'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM "hermod_audit"`).run()).toThrow(/append-only/);
    expect((await storage.audit.list()).map((e) => e.action)).toEqual(["x"]);
  });

  it("keeps the FTS index in sync when the app deletes a session (messages cascade)", async () => {
    const db = memoryDb();
    const storage = createSqliteStorage(db);
    await storage.migrate();
    const s = await session(storage);
    await storage.messages.append(s.id, { role: "user", content: "needle", text: "needle in a haystack" });
    expect(await storage.messages.search("needle")).toHaveLength(1);
    db.prepare(`DELETE FROM "hermod_sessions" WHERE id = ?`).run(s.id);
    expect(await storage.messages.search("needle")).toEqual([]);
    const integrity = db.prepare(`INSERT INTO "hermod_messages_fts" ("hermod_messages_fts", rank) VALUES ('integrity-check', 1)`);
    expect(() => integrity.run()).not.toThrow();
  });

  it("builds FTS5 queries only from quoted plain words", () => {
    expect(ftsQuery(searchTerms('Rätta "felet" OR NEAR(x*) -y'))).toBe('"ratta" OR "felet" OR "or" OR "near" OR "x" OR "y"');
    expect(ftsQuery(['a"b'])).toBe('"a""b"');
    expect(ftsQuery(searchTerms("'; drop table x; --"))).toBe('"drop" OR "table" OR "x"');
  });

  it("never throws on random hostile queries", async () => {
    const db = memoryDb();
    const storage = createSqliteStorage(db);
    await storage.migrate();
    const s = await session(storage);
    await storage.messages.append(s.id, { role: "user", content: "x", text: "Rätta felet i koden NEAR the end" });
    const alphabet = ['"', "'", "(", ")", "*", ":", "^", "-", "+", "AND", "OR", "NOT", "NEAR", " ", "ä", "x", "{", "}", "\u0000", "\uD800", "😀", "́", ",", "rätta"];
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 400; i++) {
      const query = Array.from({ length: 1 + Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      await expect(storage.messages.search(query), JSON.stringify(query)).resolves.toBeInstanceOf(Array);
    }
  });

  it("works across two connections to one WAL database file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermod-sqlite-"));
    dirs.push(dir);
    const file = join(dir, "app.db");
    const first = new Database(file);
    first.pragma("journal_mode = WAL");
    const second = new Database(file);
    open.push(first, second);
    const a = createSqliteStorage(first);
    const b = createSqliteStorage(second);
    await a.migrate();
    await b.migrate();
    const s = await session(a);
    await a.messages.append(s.id, { role: "user", content: "x", text: "över" });
    await b.messages.append(s.id, { role: "assistant", content: "y", text: "under" });
    expect((await b.messages.list(s.id)).map((m) => m.seq)).toEqual([0, 1]);
    expect((await b.messages.search("over")).map((h) => h.seq)).toEqual([0]);
    for (let i = 0; i < 6; i++) {
      await a.jobs.upsert({ agentId: "a", name: `j${i}`, schedule: "* * * * *", timeZone: "UTC", prompt: "", deliver: "inapp:owner", nextRunAt: "2026-01-01T00:00:00Z" });
    }
    const [one, two] = await Promise.all([
      a.jobs.claimDue("2026-01-01T00:00:00Z", { leaseMs: 60_000, worker: "a", limit: 4 }),
      b.jobs.claimDue("2026-01-01T00:00:00Z", { leaseMs: 60_000, worker: "b", limit: 4 }),
    ]);
    expect(one).toHaveLength(4);
    expect(two).toHaveLength(2);
    expect(new Set([...one, ...two].map((j) => j.id)).size).toBe(6);
  });

  it("reads rows correctly when the app turns on safeIntegers (bigints)", async () => {
    const db = memoryDb();
    db.defaultSafeIntegers(true);
    const storage = createSqliteStorage(db);
    await storage.migrate();
    const s = await session(storage);
    await storage.messages.append(s.id, { role: "user", content: "x", text: "hello" });
    const skill = await storage.skills.create({ agentId: "a", name: "s", description: "d", body: "b", createdBy: "u", pinned: true });
    expect(skill).toMatchObject({ version: 1, pinned: true, counters: { views: 0, uses: 0, patches: 0 } });
    expect((await storage.messages.list(s.id))[0]?.seq).toBe(0);
    expect(await storage.costs.sum({ agentId: "a", since: "2026-01-01" })).toBe(0);
  });
});
