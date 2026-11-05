/**
 * Postgres adapter: the conformance suite plus Postgres-specific checks, on a real server.
 *
 * Runs when HERMOD_TEST_DATABASE_URL is set (locally: postgres://postgres:postgres@localhost:5432/postgres). Without
 * it the database tests are skipped with a message, unless HERMOD_REQUIRE_PG_TESTS=1 (CI sets both), which makes
 * the run fail instead. Every test gets a fresh schema with a random run prefix; afterAll drops every schema the
 * run created. The tests that need no database (schema names, query building, error wrapping) always run.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresStorage,
  fromPg,
  fromPostgresJs,
  pgSearchQuery,
  searchTerms,
  type SqlExecutor,
  StorageError,
  validatePostgresSchema,
} from "../../../src/storage/index.js";
import { PG_COLUMNS } from "../../../src/storage/postgres-schema.js";
import { TABLES } from "../../../src/storage/rows.js";
import type { Storage } from "../../../src/types.js";
import { runStorageConformance } from "../storage-conformance.js";

const DATABASE_URL = process.env.HERMOD_TEST_DATABASE_URL;
const REQUIRED = process.env.HERMOD_REQUIRE_PG_TESTS === "1";
const RUN = `hermod_t${randomBytes(5).toString("hex")}`;

/** An executor that records every statement and answers from a function (no database). */
function recordingExecutor(answer: (text: string, params: unknown[]) => unknown[] = () => []) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const exec: SqlExecutor = {
    async query<T>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: answer(text, params) as T[] };
    },
  };
  return { exec, calls };
}

describe("Postgres adapter without a database", () => {
  it("refuses hostile or invalid schema names before any SQL runs", () => {
    const { exec, calls } = recordingExecutor();
    const hostile = [
      "",
      "Hermod",
      "1hermod",
      'x"; DROP SCHEMA public CASCADE; --',
      "x'y",
      "x y",
      "x-y",
      "x.y",
      "pg_catalog",
      "pg_temp",
      "a".repeat(64),
      "här",
      "x\u0000",
    ];
    for (const schema of hostile) {
      expect(() => createPostgresStorage(exec, { schema }), JSON.stringify(schema)).toThrow(StorageError);
      expect(() => validatePostgresSchema(schema)).toThrow(/schema name/);
    }
    expect(() => validatePostgresSchema(42)).toThrow(StorageError);
    expect(validatePostgresSchema("a".repeat(63))).toBe("a".repeat(63));
    expect(validatePostgresSchema("_app_hermod")).toBe("_app_hermod");
    expect(calls).toEqual([]);
  });

  it("refuses something that is not a SqlExecutor", () => {
    expect(() => createPostgresStorage(null as unknown as SqlExecutor)).toThrow(/SqlExecutor/);
    expect(() => createPostgresStorage({} as SqlExecutor)).toThrow(/SqlExecutor/);
  });

  it("uses the schema \"hermod\" by default, quoted and qualified, and sends values only as parameters", async () => {
    const { exec, calls } = recordingExecutor();
    const storage = createPostgresStorage(exec);
    await storage.migrate();
    const evil = `'; DROP TABLE x; -- "q"`;
    await storage.agents.get(evil);
    await storage.messages.search(`${evil} ratta`);
    expect(calls[0]!.text).toContain('CREATE SCHEMA "hermod"');
    expect(calls[0]!.text).toContain('"hermod"."agents"');
    expect(calls[1]!.text).toContain('FROM "hermod"."agents" AS r WHERE r.id = $1::text');
    expect(calls[1]!.params).toEqual([evil]);
    for (const { text } of calls.slice(1)) expect(text).not.toContain("DROP");
    expect(calls[2]!.params[0]).toBe('"drop" or "table" or "x" or "q" or "ratta"');
  });

  it("does not touch the database for a search without words or with limit 0", async () => {
    const { exec, calls } = recordingExecutor();
    const storage = createPostgresStorage(exec, { schema: "s" });
    expect(await storage.messages.search("()*:&|!<->")).toEqual([]);
    expect(await storage.messages.search("ratta", { limit: 0 })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("builds websearch queries only from quoted plain words", () => {
    expect(pgSearchQuery(searchTerms('Rätta "felet" OR -x <-> y:* !z & (w)'))).toBe(
      '"ratta" or "felet" or "or" or "x" or "y" or "z" or "w"',
    );
    expect(pgSearchQuery(['a"b'])).toBe('"a b"');
    expect(pgSearchQuery([])).toBe("");
  });

  it("turns driver errors into StorageErrors that keep the SQLSTATE and the cause", async () => {
    const failure = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const exec: SqlExecutor = {
      query: async () => {
        throw failure;
      },
    };
    const error = await createPostgresStorage(exec).agents.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).message).toMatch(/Postgres refused the agent list: relation does not exist \(SQLSTATE 42P01\)/);
    expect((error as StorageError).cause).toBe(failure);
  });

  it("refuses executor results that are not rows of JSON objects", async () => {
    const noRows = { query: async () => ({}) } as unknown as SqlExecutor;
    await expect(createPostgresStorage(noRows).agents.list()).rejects.toThrow(/no rows array/);
    const { exec } = recordingExecutor(() => [{ row: "[1, 2]" }]);
    await expect(createPostgresStorage(exec).agents.list()).rejects.toThrow(/not a JSON object/);
    const { exec: wrongShape } = recordingExecutor(() => [{ row: JSON.stringify({ id: 1 }) }]);
    await expect(createPostgresStorage(wrongShape).agents.list()).rejects.toBeInstanceOf(StorageError);
  });

  it("fromPostgresJs and fromPg pass text and params through and turn undefined into null", async () => {
    const seen: unknown[][] = [];
    const postgresJs = fromPostgresJs({
      unsafe: async (_text: string, params: unknown[] = []) => {
        seen.push(params);
        return [{ row: "{}" }];
      },
    });
    const pg = fromPg({
      query: async (_text: string, values: unknown[] = []) => {
        seen.push(values);
        return { rows: [{ row: "{}" }], rowCount: 1 };
      },
    });
    expect(await postgresJs.query("select 1", ["a", undefined, 2])).toEqual({ rows: [{ row: "{}" }] });
    expect(await pg.query("select 1", [true, undefined])).toEqual({ rows: [{ row: "{}" }] });
    expect(await pg.query("select 1")).toEqual({ rows: [{ row: "{}" }] });
    expect(seen).toEqual([["a", null, 2], [true, null], []]);
  });
});

if (!DATABASE_URL) {
  const message =
    "Postgres storage tests need HERMOD_TEST_DATABASE_URL (e.g. postgres://postgres:postgres@localhost:5432/postgres).";
  if (REQUIRED) {
    describe("Postgres storage", () => {
      it("HERMOD_REQUIRE_PG_TESTS=1 but HERMOD_TEST_DATABASE_URL is not set", () => {
        throw new Error(`${message} HERMOD_REQUIRE_PG_TESTS=1 makes a missing database a failure.`);
      });
    });
  } else {
    console.warn(`Skipping: ${message}`);
    describe.skip(`Postgres storage (skipped: ${message})`, () => {
      it("needs a database", () => {});
    });
  }
} else {
  const url = DATABASE_URL;
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  const exec = fromPostgresJs(sql);
  let counter = 0;
  const newSchema = () => `${RUN}_${++counter}`;
  const dropSchema = async (schema: string) => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${validatePostgresSchema(schema)}" CASCADE`);
  };

  afterAll(async () => {
    const left = await sql.unsafe(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`${RUN}%`]);
    for (const row of left) await dropSchema(String(row.nspname));
    await sql.end();
  });

  runStorageConformance("Postgres (postgres.js)", async ({ now }) => {
    const schema = newSchema();
    return { storage: createPostgresStorage(exec, { schema, now }), cleanup: () => dropSchema(schema) };
  });

  describe("Postgres adapter specifics", () => {
    let schema: string;
    let storage: Storage;
    beforeAll(async () => {
      schema = newSchema();
      storage = createPostgresStorage(exec, { schema });
      await storage.migrate();
    });
    const fresh = async () => {
      const name = newSchema();
      const made = createPostgresStorage(exec, { schema: name });
      await made.migrate();
      return { name, storage: made };
    };
    const session = (s: Storage, agentId = "agent-a") =>
      s.sessions.create({ agentId, kind: "chat", attended: true, memorySnapshot: "", skillsIndex: "" });

    it("enables row level security on every table and says policies are the app's job", async () => {
      const rows = await sql.unsafe(
        `SELECT c.relname, c.relrowsecurity, obj_description(c.oid, 'pg_class') AS note
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
        [schema],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES, "migrations"].sort());
      for (const row of rows) {
        expect(row.relrowsecurity, String(row.relname)).toBe(true);
        expect(String(row.note), String(row.relname)).toMatch(/policies is the app's job/);
      }
      const policies = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1`, [schema]);
      expect(policies[0]?.n).toBe(0);
    });

    it("a role without policies sees no rows (RLS is really on)", async () => {
      const role = `${schema}_reader`;
      await storage.agents.upsert({ id: "visible-to-owner", name: "A" });
      await sql.begin(async (tx) => {
        await tx.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
        await tx.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        await tx.unsafe(`GRANT SELECT ON "${schema}"."agents" TO "${role}"`);
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        const seen = await tx.unsafe(`SELECT count(*)::int AS n FROM "${schema}"."agents"`);
        expect(seen[0]?.n).toBe(0);
        await tx.unsafe(`RESET ROLE`);
        await tx.unsafe(`REVOKE ALL ON "${schema}"."agents" FROM "${role}"`);
        await tx.unsafe(`REVOKE ALL ON SCHEMA "${schema}" FROM "${role}"`);
        await tx.unsafe(`DROP ROLE "${role}"`);
      });
      expect((await storage.agents.get("visible-to-owner"))?.name).toBe("A");
    });

    it("migrate() twice (and concurrently on a new schema) is a no-op that records version 1 once", async () => {
      const name = newSchema();
      const made = createPostgresStorage(exec, { schema: name });
      await Promise.all([made.migrate(), made.migrate(), made.migrate()]);
      const objects = async () =>
        (
          await sql.unsafe(
            `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
            [name],
          )
        )[0]?.n;
      const before = await objects();
      await made.migrate();
      await made.migrate();
      expect(await objects()).toBe(before);
      const versions = await sql.unsafe(`SELECT version::int AS version, name FROM "${name}"."migrations"`);
      expect([...versions]).toEqual([{ version: 1, name: "initial schema" }]);
    });

    it("stores JSON as jsonb, times as timestamptz and whole numbers as bigint", async () => {
      const columns = await sql.unsafe(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1`,
        [schema],
      );
      const type = (table: string, column: string) =>
        columns.find((c) => c.table_name === table && c.column_name === column)?.data_type;
      for (const [table, kinds] of Object.entries(PG_COLUMNS)) {
        for (const [column, kind] of Object.entries(kinds)) {
          const expected = {
            text: "text",
            int: "bigint",
            float: "double precision",
            bool: "boolean",
            json: "jsonb",
            time: "timestamp with time zone",
          }[kind];
          expect(type(table, column), `${table}.${column}`).toBe(expected);
        }
      }
    });

    it("keeps a folded copy of each message's text and a generated tsvector with a GIN index", async () => {
      const s = await session(storage);
      const m = await storage.messages.append(s.id, { role: "user", content: "x", text: "Rätta FELET, över!" });
      const rows = await sql.unsafe(`SELECT search_text, search_tsv::text AS tsv FROM "${schema}"."messages" WHERE id = $1`, [
        m.id,
      ]);
      expect(rows[0]).toEqual({ search_text: "ratta felet over", tsv: "'felet':2 'over':3 'ratta':1" });
      const indexes = await sql.unsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'messages'`, [
        schema,
      ]);
      expect(indexes.some((i) => /USING gin \(search_tsv\)/.test(String(i.indexdef)))).toBe(true);
      const generated = await sql.unsafe(
        `SELECT is_generated, generation_expression FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'messages' AND column_name = 'search_tsv'`,
        [schema],
      );
      expect(generated[0]?.is_generated).toBe("ALWAYS");
      expect(String(generated[0]?.generation_expression)).toContain("'simple'");
    });

    it("snippets match the other adapters' format: original spelling, matched words marked", async () => {
      const s = await session(storage, "agent-snippet");
      await storage.messages.append(s.id, { role: "user", content: "x", text: "Vi ska Rätta felet i koden nu." });
      const [hit] = await storage.messages.search("ratta koden", { agentId: "agent-snippet" });
      expect(hit?.snippet).toBe("Vi ska **Rätta** felet i **koden** nu");
    });

    it("refuses to change or remove audit entries even with raw SQL", async () => {
      await storage.audit.append({ at: "2026-11-05T08:00:00.000Z", actor: "system", action: "kept", target: "t", details: {} });
      for (const statement of [
        `UPDATE "${schema}"."audit" SET action = 'forged'`,
        `DELETE FROM "${schema}"."audit"`,
        `TRUNCATE "${schema}"."audit"`,
      ]) {
        await expect(sql.unsafe(statement), statement).rejects.toThrow(/append-only/);
      }
      expect((await storage.audit.list({ action: "kept" })).map((e) => e.action)).toEqual(["kept"]);
    });

    it("two schemas in one database are independent stores", async () => {
      const one = await fresh();
      const two = await fresh();
      await one.storage.agents.upsert({ id: "a", name: "In one" });
      expect(await two.storage.agents.get("a")).toBeNull();
      const s = await session(one.storage);
      await one.storage.messages.append(s.id, { role: "user", content: "rätta", text: "rätta" });
      expect(await two.storage.messages.search("ratta")).toEqual([]);
      expect(await one.storage.messages.search("ratta")).toHaveLength(1);
    });

    it("never throws on random hostile queries", async () => {
      const s = await session(storage, "agent-fuzz");
      await storage.messages.append(s.id, { role: "user", content: "x", text: "Rätta felet i koden NEAR the end" });
      const alphabet = ['"', "'", "(", ")", "*", ":", "&", "|", "!", "<->", "-", "or", "and", " ", "ä", "x", "\\", "\u0000", "\uD800", "😀", "́", "$1", "rätta"];
      let seed = 7;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      for (let i = 0; i < 200; i++) {
        const query = Array.from({ length: 1 + Math.floor(random() * 10) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
        await expect(storage.messages.search(query, { agentId: "agent-fuzz" }), JSON.stringify(query)).resolves.toBeInstanceOf(Array);
      }
    });

    it("fromPostgresJs passes params with their types to the server", async () => {
      const result = await exec.query<{ a: string; b: number; c: boolean; d: null }>(
        "SELECT $1::text AS a, $2::int AS b, $3::boolean AS c, $4::text AS d",
        ["x'; --", 2, true, null],
      );
      expect(result.rows).toEqual([{ a: "x'; --", b: 2, c: true, d: null }]);
    });

    it("works through fromPg with a pg-shaped client (query(text, values) → { rows })", async () => {
      const seen: string[] = [];
      const pgLike = {
        async query(text: string, values?: unknown[]) {
          seen.push(text);
          // Answer the way pg does (a result object with rows), on the real server through postgres.js.
          const { rows } = await exec.query(text, values);
          return { rows, rowCount: rows.length, command: "", fields: [] };
        },
      };
      const name = newSchema();
      const viaPg = createPostgresStorage(fromPg(pgLike), { schema: name });
      await viaPg.migrate();
      const s = await session(viaPg);
      await viaPg.messages.append(s.id, { role: "user", content: [{ type: "text", text: "över" }], text: "över" });
      expect((await viaPg.messages.search("OVER")).map((h) => h.sessionId)).toEqual([s.id]);
      expect(seen.length).toBeGreaterThan(3);
    });

    it("concurrent appends from separate storage instances on one session never reuse a seq", async () => {
      const secondPool = postgres(url, { max: 4, onnotice: () => {} });
      const other = createPostgresStorage(fromPostgresJs(secondPool), { schema });
      const s = await session(storage);
      const all = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          (i % 2 ? other : storage).messages.append(s.id, { role: "user", content: "x", text: `m${i}` }),
        ),
      ).finally(() => secondPool.end());
      expect(all.map((m) => m.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    });

    it("a time Postgres cannot store (year 0000) is a StorageError, and nothing is written", async () => {
      await expect(
        storage.audit.append({ at: "0000-06-01T00:00:00Z", actor: "system", action: "year-zero", target: "t", details: {} }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(await storage.audit.list({ action: "year-zero" })).toEqual([]);
    });
  });
}
