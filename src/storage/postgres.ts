/**
 * Postgres Storage on any client the app already has, through a small SqlExecutor (`query(text, params) → {rows}`).
 * No driver is imported here: fromPostgresJs wraps a `postgres` (porsager) Sql, fromPg a `pg` Pool or Client.
 *
 * - Everything lives in one schema (default "hermod"), always schema-qualified and quoted; the schema name is
 *   validated before it reaches any SQL. Every parameter is a numbered placeholder with an explicit cast.
 * - Every write is ONE statement, so it is atomic without a transaction and works on a pool: compare-and-set updates
 *   (memory.writeContent, proposals.transition) are a single UPDATE … WHERE … RETURNING; writes that touch two
 *   tables (a skill and its version row, a message and its session's seq counter) are data-modifying CTEs.
 * - messages.append takes the next seq from the session row (`next_seq`, updated with RETURNING), so concurrent
 *   appends queue on that row and never reuse a seq.
 * - jobs.claimDue is one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING: two claimers
 *   never get the same job.
 * - Search: each message stores its text's folded words (search_text, built by buildSearchText, the same folding the
 *   other adapters use) and a generated to_tsvector('simple', …) column with a GIN index. A query becomes its plain
 *   folded words, each quoted, OR-ed, through websearch_to_tsquery('simple', …), so no tsquery syntax from the
 *   caller reaches Postgres. Ranked by ts_rank_cd; snippets come from buildSnippet, as in the in-memory adapter.
 * - Rows come back as one JSON text column (see pgRowJson), so drivers' type parsing never matters.
 * - close() does nothing: the app owns the connection pool and ends it.
 */
import type { Id, Storage } from "../types.js";
import {
  agentPatch,
  agentUpsertChanges,
  buildAgent,
  buildAudit,
  buildCost,
  buildDelivery,
  buildJob,
  buildMemoryStore,
  buildMessage,
  buildProposal,
  buildSearchText,
  buildSession,
  buildSkill,
  buildSnippet,
  claimArgs,
  compareText,
  DEFAULT_SEARCH_LIMIT,
  DELIVERY_STATUSES,
  DRAFT_SCORES,
  errorMessage,
  expectedSkillVersion,
  finishWorker,
  jobFields,
  jobOutcome,
  makeClock,
  memoryPolicy,
  normalizeLimit,
  optionalId,
  optionalIso,
  optionalText,
  pickId,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  requireBoolean,
  requireId,
  requireInteger,
  requireIso,
  requireOneOf,
  requireText,
  searchTerms,
  SESSION_KINDS,
  sessionPatch,
  SKILL_COUNTERS,
  SKILL_STATUSES,
  skillChange,
  skillVersionMeta,
  StorageError,
  transitionArgs,
  type Clock,
  type StorageOptions,
} from "./common.js";
import {
  agentFromRow,
  auditFromRow,
  costFromRow,
  deliveryFromRow,
  jobFromRow,
  memoryStoreFromRow,
  messageFromRow,
  proposalFromRow,
  type Row,
  searchHitFromRow,
  sessionFromRow,
  skillFromRow,
  skillToRow,
  skillVersionFromRow,
  type TableName,
  toRow,
} from "./rows.js";
import {
  PG_CAST,
  pgColumnKind,
  pgIso,
  type PgKind,
  pgMigrateSql,
  pgRowJson,
  pgTables,
  type PgTables,
  POSTGRES_DEFAULT_SCHEMA,
  validatePostgresSchema,
} from "./postgres-schema.js";

// ─── Executors ──────────────────────────────────────────────────────────────────────────────────────────────

/** Runs one SQL statement with numbered parameters ($1, $2 …) and returns its rows. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** The part of a `postgres` (porsager) Sql the adapter uses: `sql.unsafe(text, params)`. */
export interface PostgresJsSql {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<Iterable<unknown>>;
}

/** The part of a `pg` Pool or Client the adapter uses: `query(text, values) → { rows }`. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): PromiseLike<{ rows: unknown[] }>;
}

/** Undefined is not a SQL value; the adapter never sends it, and the drivers would refuse it. */
const sqlValues = (params: unknown[] = []) => params.map((value) => (value === undefined ? null : value));

/** A SqlExecutor over a `postgres` (porsager) Sql or reserved connection. */
export function fromPostgresJs(sql: PostgresJsSql): SqlExecutor {
  return {
    async query<T>(text: string, params?: unknown[]) {
      const result = await sql.unsafe(text, sqlValues(params));
      return { rows: Array.from(result) as T[] };
    },
  };
}

/** A SqlExecutor over a `pg` Pool or Client. */
export function fromPg(client: PgQueryable): SqlExecutor {
  return {
    async query<T>(text: string, params?: unknown[]) {
      const result = await client.query(text, sqlValues(params));
      return { rows: result.rows as T[] };
    },
  };
}

// ─── Options ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PostgresStorageOptions extends StorageOptions {
  /** The schema for every table. Default "hermod". Must match ^[a-z_][a-z0-9_]{0,62}$ (and not start with "pg_"). */
  schema?: string;
}

/** Plain folded words → a websearch_to_tsquery string: each word quoted, OR-ed together. */
export function pgSearchQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', " ")}"`).join(" or ");
}

// ─── Running statements ─────────────────────────────────────────────────────────────────────────────────────

/** Builds the parameter list of one statement: add() returns "$n::type" for a value. */
interface Params {
  readonly values: unknown[];
  add(value: unknown, kind?: PgKind): string;
}

function params(): Params {
  const values: unknown[] = [];
  return {
    values,
    add(value, kind = "text") {
      values.push(value === undefined ? null : value);
      return `$${values.length}${PG_CAST[kind]}`;
    },
  };
}

/** The SQLSTATE of a driver error, when it has one (both drivers put it in `code`). */
export function pgErrorCode(error: unknown): string | null {
  const code: unknown = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : null;
}

const UNIQUE_VIOLATION = "23505";

interface Db {
  /** Runs a statement whose rows have one JSON text column named "row". */
  rows(what: string, text: string, p?: Params): Promise<Row[]>;
  one(what: string, text: string, p?: Params): Promise<Row | null>;
  run(what: string, text: string, p?: Params): Promise<void>;
}

function parseRow(value: unknown, what: string): Row {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorageError(`Postgres returned a row for ${what} that is not a JSON object.`);
  }
  return parsed as Row;
}

function createDb(exec: SqlExecutor): Db {
  const query = async (what: string, text: string, p?: Params): Promise<unknown[]> => {
    let result: { rows: unknown[] } | undefined;
    try {
      result = await exec.query(text, p?.values ?? []);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const code = pgErrorCode(error);
      throw new StorageError(`Postgres refused ${what}: ${errorMessage(error)}${code ? ` (SQLSTATE ${code})` : ""}`, {
        cause: error,
      });
    }
    if (!result || !Array.isArray(result.rows)) {
      throw new StorageError(`The SqlExecutor returned no rows array for ${what}.`);
    }
    return result.rows;
  };
  const rows = async (what: string, text: string, p?: Params) =>
    (await query(what, text, p)).map((row) => parseRow(Reflect.get(Object(row), "row"), what));
  return {
    rows,
    one: async (what, text, p) => (await rows(what, text, p))[0] ?? null,
    run: async (what, text, p) => {
      await query(what, text, p);
    },
  };
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new StorageError(`Postgres returned no row for ${what}.`);
  return value;
}

const quote = (column: string) => `"${column}"`;

/** "INSERT INTO <table> AS r (…) VALUES (…)" with a cast placeholder per column. */
function insertInto(t: PgTables, table: TableName, row: Row, p: Params): string {
  const columns = Object.keys(row);
  const values = columns.map((column) => p.add(row[column], pgColumnKind(table, column)));
  return `INSERT INTO ${t[table]} AS r (${columns.map(quote).join(", ")}) VALUES (${values.join(", ")})`;
}

/** "a = $1::text, b = $2::bigint" for a row of `table`. */
function setList(table: TableName, row: Row, p: Params): string {
  return Object.entries(row)
    .map(([column, value]) => `${quote(column)} = ${p.add(value, pgColumnKind(table, column))}`)
    .join(", ");
}

/** "WHERE r.a = $1 AND r.b = $2" for the conditions whose value is not null. */
function whereAll(table: TableName, conditions: Array<[string, unknown]>, p: Params): string {
  const active = conditions.filter(([, value]) => value !== null && value !== undefined);
  if (active.length === 0) return "";
  return `WHERE ${active.map(([column, value]) => `r.${quote(column)} = ${p.add(value, pgColumnKind(table, column))}`).join(" AND ")}`;
}

/** LIMIT NULL means no limit in Postgres. */
const limitClause = (limit: number | null, p: Params) => `LIMIT ${p.add(limit, "int")}`;

// ─── The adapter ────────────────────────────────────────────────────────────────────────────────────────────

export function createPostgresStorage(exec: SqlExecutor, options: PostgresStorageOptions = {}): Storage {
  const schema = validatePostgresSchema(options.schema ?? POSTGRES_DEFAULT_SCHEMA);
  if (!exec || typeof exec.query !== "function") {
    throw new StorageError("createPostgresStorage needs a SqlExecutor with a query(text, params) method.");
  }
  const t = pgTables(schema);
  const clock = makeClock(options);
  const db = createDb(exec);
  return {
    async migrate() {
      await db.run("the migration", pgMigrateSql(schema));
    },
    async close() {
      // The app owns the pool or client and ends it; the adapter holds nothing else.
    },
    agents: agentsRepo(db, t, clock),
    sessions: sessionsRepo(db, t, clock),
    messages: messagesRepo(db, t, clock),
    memory: memoryRepo(db, t, clock),
    skills: skillsRepo(db, t, clock),
    proposals: proposalsRepo(db, t, clock),
    audit: auditRepo(db, t, clock),
    costs: costsRepo(db, t, clock),
    jobs: jobsRepo(db, t, clock),
    deliveries: deliveriesRepo(db, t, clock),
  };
}

/** SELECT <row json> FROM <table> AS r … */
const select = (t: PgTables, table: TableName) => `SELECT ${pgRowJson(table, "r")} AS row FROM ${t[table]} AS r`;
const returning = (table: TableName) => `RETURNING ${pgRowJson(table, "r")} AS row`;

/** Gets one row of `table` by id. */
async function byId(db: Db, t: PgTables, table: TableName, id: Id): Promise<Row | null> {
  const p = params();
  return db.one(`a ${table} lookup`, `${select(t, table)} WHERE r.id = ${p.add(id)}`, p);
}

/** Updates one row of `table` by id and returns it (null when there is no such row). */
async function updateById(db: Db, t: PgTables, table: TableName, id: Id, changes: Row): Promise<Row | null> {
  const p = params();
  const set = setList(table, changes, p);
  return db.one(`a ${table} update`, `UPDATE ${t[table]} AS r SET ${set} WHERE r.id = ${p.add(id)} ${returning(table)}`, p);
}

/** Inserts a record unless its id exists; a duplicate id is a StorageError. */
async function insertNew(db: Db, t: PgTables, table: TableName, row: Row, what: string): Promise<Row> {
  const p = params();
  const text = `${insertInto(t, table, row, p)} ON CONFLICT (id) DO NOTHING ${returning(table)}`;
  const inserted = await db.one(`a ${table} insert`, text, p);
  if (!inserted) throw new StorageError(`${what} with id "${String(row.id)}" already exists.`);
  return inserted;
}

function agentsRepo(db: Db, t: PgTables, clock: Clock): Storage["agents"] {
  return {
    async upsert(input) {
      const at = clock.nowIso();
      const row = toRow("agents", buildAgent(input, at));
      const changed = Object.keys(toRow("agents", agentUpsertChanges(input, at)));
      const p = params();
      const update = changed.map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`).join(", ");
      const text = `${insertInto(t, "agents", row, p)} ON CONFLICT (id) DO UPDATE SET ${update} ${returning("agents")}`;
      return agentFromRow(must(await db.one("an agent upsert", text, p), "an agent upsert"));
    },
    async get(id) {
      const row = await byId(db, t, "agents", id);
      return row ? agentFromRow(row) : null;
    },
    async list() {
      const rows = await db.rows("the agent list", `${select(t, "agents")} ORDER BY r.created_at, r.id COLLATE "C"`);
      return rows.map(agentFromRow);
    },
    async update(id, patch) {
      const changes = toRow("agents", agentPatch(patch ?? {}));
      const row =
        Object.keys(changes).length === 0
          ? await byId(db, t, "agents", id)
          : await updateById(db, t, "agents", id, { ...changes, updated_at: clock.nowIso() });
      return row ? agentFromRow(row) : null;
    },
  };
}

function sessionsRepo(db: Db, t: PgTables, clock: Clock): Storage["sessions"] {
  return {
    async create(input) {
      const record = buildSession(input, pickId(input?.id, clock, "Session id"), clock.nowIso());
      return sessionFromRow(await insertNew(db, t, "sessions", toRow("sessions", record), "A session"));
    },
    async get(id) {
      const row = await byId(db, t, "sessions", id);
      return row ? sessionFromRow(row) : null;
    },
    async update(id, patch) {
      const changes = toRow("sessions", sessionPatch(patch ?? {}));
      const row =
        Object.keys(changes).length === 0
          ? await byId(db, t, "sessions", id)
          : await updateById(db, t, "sessions", id, changes);
      return row ? sessionFromRow(row) : null;
    },
    async listByAgent(agentId, options) {
      const kind = options?.kind === undefined ? null : requireOneOf(options.kind, SESSION_KINDS, "Session kind");
      const limit = normalizeLimit(options?.limit, null);
      const p = params();
      const where = whereAll("sessions", [["agent_id", agentId], ["kind", kind]], p);
      const text = `${select(t, "sessions")} ${where} ORDER BY r.started_at DESC, r.ord DESC ${limitClause(limit, p)}`;
      return (await db.rows("the session list", text, p)).map(sessionFromRow);
    },
  };
}

function messagesRepo(db: Db, t: PgTables, clock: Clock): Storage["messages"] {
  return {
    async append(sessionId, input) {
      const id = requireId(sessionId, "Message sessionId");
      // seq is assigned by the database below; 0 is only a placeholder for the record builder.
      const record = buildMessage(id, input, clock.newId(), 0, clock.nowIso());
      const p = params();
      const session = p.add(id);
      const values = [
        p.add(record.id),
        "s.seq",
        p.add(record.role),
        p.add(toRow("messages", { content: record.content }).content, "json"),
        p.add(record.text),
        p.add(buildSearchText(record.text)),
        p.add(record.createdAt, "time"),
      ];
      const text = `WITH s AS (
          UPDATE ${t.sessions} SET next_seq = next_seq + 1 WHERE id = ${session} RETURNING id, next_seq - 1 AS seq
        )
        INSERT INTO ${t.messages} AS r (id, session_id, seq, role, content, "text", search_text, created_at)
        SELECT ${values[0]}, s.id, ${values.slice(1).join(", ")} FROM s
        ${returning("messages")}`;
      const row = await db.one("a message insert", text, p);
      if (!row) throw new StorageError(`Cannot append a message: there is no session with id "${id}".`);
      return messageFromRow(row);
    },
    async list(sessionId) {
      const p = params();
      const text = `${select(t, "messages")} WHERE r.session_id = ${p.add(sessionId)} ORDER BY r.seq`;
      return (await db.rows("the message list", text, p)).map(messageFromRow);
    },
    async get(id) {
      const row = await byId(db, t, "messages", id);
      return row ? messageFromRow(row) : null;
    },
    async search(query, options) {
      const terms = searchTerms(query);
      const agentId = optionalId(options?.agentId, "Search agentId");
      const excludeSessionId = optionalId(options?.excludeSessionId, "Search excludeSessionId");
      const limit = normalizeLimit(options?.limit, DEFAULT_SEARCH_LIMIT);
      if (terms.length === 0 || limit === 0) return [];
      const p = params();
      const tsquery = `websearch_to_tsquery('simple', ${p.add(pgSearchQuery(terms))})`;
      const agent = p.add(agentId);
      const excluded = p.add(excludeSessionId);
      const text = `SELECT json_build_object(
            'id', h.id, 'session_id', h.session_id, 'seq', h.seq, 'role', h.role,
            'created_at', ${pgIso("h.created_at")}, 'text', h."text", 'score', h.score
          )::text AS row
        FROM (
          SELECT m.id, m.session_id, m.seq, m.role, m.created_at, m."text", m.ord,
            ts_rank_cd(m.search_tsv, q.query)::float8 AS score
          FROM ${t.messages} AS m
          JOIN ${t.sessions} AS s ON s.id = m.session_id
          CROSS JOIN ${tsquery} AS q(query)
          WHERE m.search_tsv @@ q.query
            AND (${agent} IS NULL OR s.agent_id = ${agent})
            AND (${excluded} IS NULL OR m.session_id <> ${excluded})
          ORDER BY score DESC, m.created_at DESC, m.ord DESC
          ${limitClause(limit, p)}
        ) AS h
        ORDER BY h.score DESC, h.created_at DESC, h.ord DESC`;
      const rows = await db.rows("a message search", text, p);
      return rows.map((row) => searchHitFromRow({ ...row, snippet: buildSnippet(String(row.text ?? ""), terms) }));
    },
  };
}

function memoryRepo(db: Db, t: PgTables, clock: Clock): Storage["memory"] {
  const byKey = async (agentId: Id, name: string) => {
    const p = params();
    const text = `${select(t, "memory_stores")} WHERE r.agent_id = ${p.add(agentId)} AND r.name = ${p.add(name)}`;
    return db.one("a memory store lookup", text, p);
  };
  return {
    async ensureStore(agentId, name, defaults) {
      const record = buildMemoryStore(agentId, name, defaults, clock.newId(), clock.nowIso());
      const p = params();
      const text = `${insertInto(t, "memory_stores", toRow("memory_stores", record), p)}
        ON CONFLICT (agent_id, name) DO NOTHING ${returning("memory_stores")}`;
      // A second statement sees a store that a concurrent call committed while this insert waited on it.
      const row =
        (await db.one("a memory store insert", text, p)) ?? (await byKey(record.agentId, record.name));
      return memoryStoreFromRow(must(row, "a memory store"));
    },
    async getStore(agentId, name) {
      const row = await byKey(agentId, name);
      return row ? memoryStoreFromRow(row) : null;
    },
    async listStores(agentId) {
      const p = params();
      const text = `${select(t, "memory_stores")} WHERE r.agent_id = ${p.add(agentId)} ORDER BY r.name COLLATE "C", r.id COLLATE "C"`;
      return (await db.rows("the memory store list", text, p)).map(memoryStoreFromRow);
    },
    async writeContent(id, content, expectedVersion) {
      const p = params();
      const set = `content = ${p.add(requireText(content, "Memory store content"))}, version = r.version + 1,
        updated_at = ${p.add(clock.nowIso(), "time")}`;
      const expected = p.add(requireInteger(expectedVersion, "expectedVersion"), "int");
      const text = `UPDATE ${t.memory_stores} AS r SET ${set}
        WHERE r.id = ${p.add(id)} AND r.version = ${expected} ${returning("memory_stores")}`;
      const row = await db.one("a memory write", text, p);
      return row ? memoryStoreFromRow(row) : null;
    },
    async setPolicy(id, policy) {
      const changes = toRow("memory_stores", memoryPolicy(policy ?? {}));
      const row =
        Object.keys(changes).length === 0
          ? await byId(db, t, "memory_stores", id)
          : await updateById(db, t, "memory_stores", id, { ...changes, updated_at: clock.nowIso() });
      return row ? memoryStoreFromRow(row) : null;
    },
  };
}

function skillsRepo(db: Db, t: PgTables, clock: Clock): Storage["skills"] {
  /** Columns of skill_versions in insert order, for "INSERT … SELECT … FROM s". */
  const versionColumns = "skill_id, version, description, body, created_at, created_by, proposal_id";
  const updateOne = async (id: Id, changes: Row) => {
    const row = await updateById(db, t, "skills", id, changes);
    return row ? skillFromRow(row) : null;
  };
  return {
    async create(input) {
      const { skill, version } = buildSkill(input, clock.newId(), clock.nowIso());
      const p = params();
      const insertSkill = `${insertInto(t, "skills", skillToRow(skill), p)} ON CONFLICT (agent_id, name) DO NOTHING RETURNING r.*`;
      const v = toRow("skill_versions", version);
      const text = `WITH s AS (${insertSkill}),
        v AS (
          INSERT INTO ${t.skill_versions} (${versionColumns})
          SELECT s.id, s.version, s.description, s.body, s.created_at, ${p.add(v.created_by)}, ${p.add(v.proposal_id)}
          FROM s
        )
        SELECT ${pgRowJson("skills", "s")} AS row FROM s`;
      const row = await db.one("a skill insert", text, p);
      if (!row) throw new StorageError(`A skill named "${skill.name}" already exists for agent "${skill.agentId}".`);
      return skillFromRow(row);
    },
    async get(agentId, name) {
      const p = params();
      const text = `${select(t, "skills")} WHERE r.agent_id = ${p.add(agentId)} AND r.name = ${p.add(name)}`;
      const row = await db.one("a skill lookup", text, p);
      return row ? skillFromRow(row) : null;
    },
    async list(agentId, options) {
      const status = options?.status === undefined ? null : requireOneOf(options.status, SKILL_STATUSES, "Skill status");
      const p = params();
      const where = whereAll("skills", [["agent_id", agentId], ["status", status]], p);
      const text = `${select(t, "skills")} ${where} ORDER BY r.name COLLATE "C", r.id COLLATE "C"`;
      return (await db.rows("the skill list", text, p)).map(skillFromRow);
    },
    async update(id, changeInput, metaInput, expectedVersion) {
      const content = skillChange(changeInput);
      const meta = skillVersionMeta(metaInput);
      const expected = expectedSkillVersion(expectedVersion);
      const p = params();
      const set = `description = ${p.add(content.description)}, body = ${p.add(content.body)},
        version = r.version + 1, updated_at = ${p.add(clock.nowIso(), "time")}`;
      // Compare-and-set: the UPDATE's row lock serializes concurrent updates, and the version check (re-evaluated
      // on the locked row) makes the second of two changes computed from the same version a no-op.
      const text = `WITH s AS (UPDATE ${t.skills} AS r SET ${set}
          WHERE r.id = ${p.add(id)} AND r.version = ${p.add(expected, pgColumnKind("skills", "version"))} RETURNING r.*),
        v AS (
          INSERT INTO ${t.skill_versions} (${versionColumns})
          SELECT s.id, s.version, s.description, s.body, s.updated_at, ${p.add(meta.createdBy)}, ${p.add(meta.proposalId)}
          FROM s
        )
        SELECT ${pgRowJson("skills", "s")} AS row FROM s`;
      const row = await db.one("a skill update", text, p);
      return row ? skillFromRow(row) : null;
    },
    async setStatus(id, status) {
      return updateOne(id, { status: requireOneOf(status, SKILL_STATUSES, "Skill status") });
    },
    async setPinned(id, pinned) {
      return updateOne(id, { pinned: requireBoolean(pinned, "Skill pinned") });
    },
    async bump(id, counter, at) {
      // Safe to put in SQL: requireOneOf only lets the three fixed counter names through.
      const column = quote(requireOneOf(counter, SKILL_COUNTERS, "Skill counter"));
      const p = params();
      const when = p.add(requireIso(at, "Skill bump at"), "time");
      const text = `UPDATE ${t.skills} AS r SET ${column} = r.${column} + 1, last_used_at = greatest(r.last_used_at, ${when})
        WHERE r.id = ${p.add(id)}`;
      await db.run("a skill counter update", text, p);
    },
    async versions(id) {
      const p = params();
      const text = `${select(t, "skill_versions")} WHERE r.skill_id = ${p.add(id)} ORDER BY r.version`;
      return (await db.rows("the skill version list", text, p)).map(skillVersionFromRow);
    },
  };
}

function proposalsRepo(db: Db, t: PgTables, clock: Clock): Storage["proposals"] {
  return {
    async create(input) {
      const record = buildProposal(input, pickId(input?.id, clock, "Proposal id"), clock.nowIso());
      return proposalFromRow(await insertNew(db, t, "proposals", toRow("proposals", record), "A proposal"));
    },
    async get(id) {
      const row = await byId(db, t, "proposals", id);
      return row ? proposalFromRow(row) : null;
    },
    async list(options) {
      const p = params();
      const where = whereAll(
        "proposals",
        [
          ["agent_id", optionalId(options?.agentId, "Proposal agentId")],
          ["session_id", optionalId(options?.sessionId, "Proposal sessionId")],
          ["status", options?.status === undefined ? null : requireOneOf(options.status, PROPOSAL_STATUSES, "Proposal status")],
          ["kind", options?.kind === undefined ? null : requireOneOf(options.kind, PROPOSAL_KINDS, "Proposal kind")],
        ],
        p,
      );
      const limit = normalizeLimit(options?.limit, null);
      const text = `${select(t, "proposals")} ${where} ORDER BY r.created_at DESC, r.ord DESC ${limitClause(limit, p)}`;
      return (await db.rows("the proposal list", text, p)).map(proposalFromRow);
    },
    async transition(id, from, to, decision) {
      const args = transitionArgs(from, to, decision);
      if (args.from.length === 0) return null;
      const p = params();
      const note = args.note === undefined ? "" : `, decision_note = ${p.add(args.note)}`;
      const set = `status = ${p.add(args.to)}, decided_at = ${p.add(args.at, "time")}, decided_by = ${p.add(args.by)}${note}`;
      const allowed = args.from.map((status) => p.add(status)).join(", ");
      const text = `UPDATE ${t.proposals} AS r SET ${set}
        WHERE r.id = ${p.add(id)} AND r.status IN (${allowed}) ${returning("proposals")}`;
      const row = await db.one("a proposal transition", text, p);
      return row ? proposalFromRow(row) : null;
    },
    async setScore(id, score) {
      const row = await updateById(db, t, "proposals", id, { score: requireOneOf(score, DRAFT_SCORES, "Proposal score") });
      return row ? proposalFromRow(row) : null;
    },
  };
}

function auditRepo(db: Db, t: PgTables, clock: Clock): Storage["audit"] {
  // Append-only on purpose: there is no update or delete, and triggers refuse both (and TRUNCATE) in the database.
  return {
    async append(entry) {
      const record = buildAudit(entry, pickId(entry?.id, clock, "Audit id"));
      return auditFromRow(await insertNew(db, t, "audit", toRow("audit", record), "An audit entry"));
    },
    async list(options) {
      const p = params();
      const where = whereAll(
        "audit",
        [
          ["target", optionalText(options?.target, "Audit target filter")],
          ["actor", optionalText(options?.actor, "Audit actor filter")],
          ["action", optionalText(options?.action, "Audit action filter")],
        ],
        p,
      );
      const limit = normalizeLimit(options?.limit, null);
      const text = `${select(t, "audit")} ${where} ORDER BY r.at DESC, r.ord DESC ${limitClause(limit, p)}`;
      return (await db.rows("the audit list", text, p)).map(auditFromRow);
    },
  };
}

function costsRepo(db: Db, t: PgTables, clock: Clock): Storage["costs"] {
  return {
    async add(input) {
      const record = buildCost(input, pickId(input?.id, clock, "Cost id"));
      return costFromRow(await insertNew(db, t, "costs", toRow("costs", record), "A cost record"));
    },
    async sum(options) {
      const p = params();
      const agentId = p.add(requireId(options?.agentId, "Cost sum agentId"));
      const since = p.add(requireIso(options?.since, "Cost sum since"), "time");
      const text = `SELECT json_build_object('total', coalesce(sum(r.cost_usd), 0)::float8)::text AS row
        FROM ${t.costs} AS r WHERE r.agent_id = ${agentId} AND r.at >= ${since}`;
      const row = await db.one("a cost sum", text, p);
      const total = Number(row?.total ?? 0);
      if (!Number.isFinite(total)) throw new StorageError(`Postgres returned an unexpected cost sum: ${String(row?.total)}.`);
      return total;
    },
    async list(options) {
      const p = params();
      const where = whereAll(
        "costs",
        [
          ["agent_id", optionalId(options?.agentId, "Cost agentId")],
          ["session_id", optionalId(options?.sessionId, "Cost sessionId")],
        ],
        p,
      );
      const limit = normalizeLimit(options?.limit, null);
      const text = `${select(t, "costs")} ${where} ORDER BY r.at DESC, r.ord DESC ${limitClause(limit, p)}`;
      return (await db.rows("the cost list", text, p)).map(costFromRow);
    },
  };
}

function jobsRepo(db: Db, t: PgTables, clock: Clock): Storage["jobs"] {
  const updateOne = async (id: Id, changes: Row) => {
    const row = await updateById(db, t, "jobs", id, changes);
    return row ? jobFromRow(row) : null;
  };
  return {
    async upsert(input) {
      const fields = jobFields(input);
      const givenId = input.id === undefined ? null : requireId(input.id, "Job id");
      // With an id the job is matched by id, otherwise by agent and name. Either way a second job with the same
      // agent and name violates the unique key, and that is reported as a StorageError below.
      const record = buildJob(input, givenId ?? clock.newId());
      const changed = Object.keys(toRow("jobs", fields));
      const p = params();
      const update = changed.map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`).join(", ");
      const target = givenId === null ? "(agent_id, name)" : "(id)";
      const text = `${insertInto(t, "jobs", toRow("jobs", record), p)}
        ON CONFLICT ${target} DO UPDATE SET ${update} ${returning("jobs")}`;
      try {
        return jobFromRow(must(await db.one("a job upsert", text, p), "a job upsert"));
      } catch (error) {
        if (error instanceof StorageError && pgErrorCode(error.cause) === UNIQUE_VIOLATION) {
          throw new StorageError(`A job named "${fields.name}" already exists for agent "${fields.agentId}".`, {
            cause: error.cause,
          });
        }
        throw error;
      }
    },
    async get(id) {
      const row = await byId(db, t, "jobs", id);
      return row ? jobFromRow(row) : null;
    },
    async list(options) {
      const p = params();
      const where = whereAll("jobs", [["agent_id", optionalId(options?.agentId, "Job agentId")]], p);
      const text = `${select(t, "jobs")} ${where} ORDER BY r.name COLLATE "C", r.id COLLATE "C"`;
      return (await db.rows("the job list", text, p)).map(jobFromRow);
    },
    async claimDue(now, options) {
      const args = claimArgs(now, options);
      const p = params();
      const lockedUntil = p.add(args.lockedUntil, "time");
      const worker = p.add(args.worker);
      const at = p.add(args.now, "time");
      const text = `UPDATE ${t.jobs} AS r SET locked_until = ${lockedUntil}, locked_by = ${worker}
        WHERE r.id IN (
          SELECT d.id FROM ${t.jobs} AS d
          WHERE d.enabled AND d.next_run_at IS NOT NULL AND d.next_run_at <= ${at}
            AND (d.locked_until IS NULL OR d.locked_until <= ${at})
          ORDER BY d.next_run_at, d.id COLLATE "C"
          ${limitClause(args.limit, p)}
          FOR UPDATE SKIP LOCKED
        )
        ${returning("jobs")}`;
      const jobs = (await db.rows("a job claim", text, p)).map(jobFromRow);
      return jobs.sort((a, b) => compareText(a.nextRunAt ?? "", b.nextRunAt ?? "") || compareText(a.id, b.id));
    },
    async finish(id, outcome, worker) {
      const changes = { ...toRow("jobs", jobOutcome(outcome)), locked_until: null, locked_by: null };
      const owner = finishWorker(worker);
      const p = params();
      const set = setList("jobs", changes, p);
      // Only the worker that holds the lease may save the outcome and release it (one atomic statement).
      const text = `UPDATE ${t.jobs} AS r SET ${set} WHERE r.id = ${p.add(id)} AND r.locked_by = ${p.add(owner)} ${returning("jobs")}`;
      const row = await db.one("a job finish", text, p);
      return row ? jobFromRow(row) : null;
    },
    async setEnabled(id, enabled) {
      return updateOne(id, { enabled: requireBoolean(enabled, "Job enabled") });
    },
  };
}

function deliveriesRepo(db: Db, t: PgTables, clock: Clock): Storage["deliveries"] {
  return {
    async add(input) {
      const record = buildDelivery(input, pickId(input?.id, clock, "Delivery id"), clock.nowIso());
      return deliveryFromRow(await insertNew(db, t, "deliveries", toRow("deliveries", record), "A delivery"));
    },
    async mark(id, status, error) {
      const changes = {
        status: requireOneOf(status, DELIVERY_STATUSES, "Delivery status"),
        error: optionalText(error, "Delivery error"),
      };
      const row = await updateById(db, t, "deliveries", id, changes);
      return row ? deliveryFromRow(row) : null;
    },
    async list(options) {
      const p = params();
      const conditions = [
        whereAll(
          "deliveries",
          [
            ["target", optionalText(options?.target, "Delivery target filter")],
            ["channel", optionalText(options?.channel, "Delivery channel filter")],
          ],
          p,
        ),
      ];
      const since = optionalIso(options?.since, "Delivery since");
      if (since !== null) {
        const clause = `r.created_at >= ${p.add(since, "time")}`;
        conditions.push(conditions[0] ? `AND ${clause}` : `WHERE ${clause}`);
      }
      const limit = normalizeLimit(options?.limit, null);
      const text = `${select(t, "deliveries")} ${conditions.join(" ")} ORDER BY r.created_at DESC, r.ord DESC ${limitClause(limit, p)}`;
      return (await db.rows("the delivery list", text, p)).map(deliveryFromRow);
    },
  };
}
