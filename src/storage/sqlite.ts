/**
 * SQLite Storage on a better-sqlite3 Database that the app opens and passes in. The driver is never imported here:
 * the Database is typed structurally (SqliteDatabase below), and a better-sqlite3 Database fits as is.
 *
 * - Synchronous calls wrapped in promises; every multi-step write runs in one IMMEDIATE transaction, and every
 *   compare-and-set is a single UPDATE … WHERE … RETURNING, so concurrent callers (also on other connections to the
 *   same file) cannot both win.
 * - The adapter changes no pragmas: WAL, busy timeout and foreign_keys are the app's choice.
 * - Full-text search: FTS5 over messages.text with `unicode61 remove_diacritics 2`. Queries are built from plain
 *   words only (see searchTerms and ftsQuery): each word becomes a quoted FTS5 string and the words are OR-ed, so no
 *   FTS5 syntax from the caller ever reaches MATCH. Ranked by bm25, excerpts by snippet().
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
  buildSession,
  buildSkill,
  claimArgs,
  compareText,
  DEFAULT_SEARCH_LIMIT,
  DELIVERY_STATUSES,
  DRAFT_SCORES,
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
  SNIPPET_MARKS,
  SNIPPET_WORDS,
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
  toRow,
} from "./rows.js";
import {
  SQLITE_DEFAULT_PREFIX,
  SQLITE_MIGRATIONS,
  sqliteMigrationsTable,
  sqliteTables,
  type SqliteTables,
  validateSqlitePrefix,
} from "./sqlite-schema.js";

/** The parts of a better-sqlite3 Statement the adapter uses. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The parts of a better-sqlite3 Database the adapter uses. */
export interface SqliteDatabase {
  prepare(source: string): SqliteStatement;
  exec(source: string): unknown;
  transaction(fn: () => void): { immediate(): unknown };
  /** Never called: the adapter leaves pragmas (WAL, foreign_keys, busy_timeout) to the app. */
  pragma?(source: string, options?: { simple?: boolean }): unknown;
}

export interface SqliteStorageOptions extends StorageOptions {
  /** Prefix for every table, index and trigger name. Default "hermod_". */
  prefix?: string;
}

/** Plain words → an FTS5 query: each word a quoted string (inner quotes doubled), OR-ed together. */
export function ftsQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

interface Sql {
  all(text: string, params?: readonly unknown[]): Row[];
  get(text: string, params?: readonly unknown[]): Row | null;
  run(text: string, params?: readonly unknown[]): void;
  exec(text: string): void;
  /** Runs fn in one IMMEDIATE transaction (a savepoint when already inside one). */
  tx<T>(fn: () => T): T;
  clear(): void;
}

/** better-sqlite3 binds numbers, strings, bigints, buffers and null; booleans become 1/0. */
function bindable(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value === undefined ? null : value;
}

function createSql(db: SqliteDatabase): Sql {
  const statements = new Map<string, SqliteStatement>();
  const prepared = (text: string): SqliteStatement => {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };
  const bind = (params: readonly unknown[]) => params.map(bindable);
  return {
    all: (text, params = []) => prepared(text).all(...bind(params)) as Row[],
    get: (text, params = []) => (prepared(text).get(...bind(params)) as Row | undefined) ?? null,
    run: (text, params = []) => {
      prepared(text).run(...bind(params));
    },
    exec: (text) => {
      db.exec(text);
    },
    tx<T>(fn: () => T): T {
      const result: T[] = [];
      db.transaction(() => {
        result.push(fn());
      }).immediate();
      if (result.length === 0) throw new StorageError("The SQLite transaction did not run.");
      return result[0] as T;
    },
    clear: () => statements.clear(),
  };
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new StorageError(`SQLite returned no row for ${what}.`);
  return value;
}
const one = must<Row>;

function insertSql(table: string, row: Row, suffix = ""): [string, unknown[]] {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  return [`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ${suffix}`, Object.values(row)];
}

function setList(row: Row): [string, unknown[]] {
  return [
    Object.keys(row)
      .map((column) => `${column} = ?`)
      .join(", "),
    Object.values(row),
  ];
}

/** "WHERE a = ? AND b = ?" for the conditions whose value is not null. */
function whereAll(conditions: Array<[string, unknown]>): [string, unknown[]] {
  const active = conditions.filter(([, value]) => value !== null);
  const clause = active.length > 0 ? `WHERE ${active.map(([condition]) => condition).join(" AND ")}` : "";
  return [clause, active.map(([, value]) => value)];
}

/** SQLite's LIMIT -1 means no limit. */
const sqliteLimit = (limit: number | null): number => limit ?? -1;

export function createSqliteStorage(db: SqliteDatabase, options: SqliteStorageOptions = {}): Storage {
  const prefix = validateSqlitePrefix(options.prefix ?? SQLITE_DEFAULT_PREFIX);
  const t = sqliteTables(prefix);
  const clock = makeClock(options);
  const sql = createSql(db);
  return {
    async migrate() {
      sql.tx(() => {
        sql.exec(sqliteMigrationsTable(prefix));
        const applied = new Set(sql.all(`SELECT version FROM ${t.migrations}`).map((row) => Number(row.version)));
        for (const migration of SQLITE_MIGRATIONS) {
          if (applied.has(migration.version)) continue;
          sql.exec(migration.sql(prefix));
          sql.run(`INSERT INTO ${t.migrations} (version, name, applied_at) VALUES (?, ?, ?)`, [
            migration.version,
            migration.name,
            clock.nowIso(),
          ]);
        }
      });
    },
    async close() {
      sql.clear();
    },
    agents: agentsRepo(sql, t, clock),
    sessions: sessionsRepo(sql, t, clock),
    messages: messagesRepo(sql, t, clock),
    memory: memoryRepo(sql, t, clock),
    skills: skillsRepo(sql, t, clock),
    proposals: proposalsRepo(sql, t, clock),
    audit: auditRepo(sql, t, clock),
    costs: costsRepo(sql, t, clock),
    jobs: jobsRepo(sql, t, clock),
    deliveries: deliveriesRepo(sql, t, clock),
  };
}

function agentsRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["agents"] {
  const byId = (id: Id) => {
    const row = sql.get(`SELECT * FROM ${t.agents} WHERE id = ?`, [id]);
    return row ? agentFromRow(row) : null;
  };
  return {
    async upsert(input) {
      const at = clock.nowIso();
      const row = toRow("agents", buildAgent(input, at));
      const changed = Object.keys(toRow("agents", agentUpsertChanges(input, at)));
      const update = changed.map((column) => `${column} = excluded.${column}`).join(", ");
      const [text, params] = insertSql(t.agents, row, `ON CONFLICT (id) DO UPDATE SET ${update} RETURNING *`);
      return agentFromRow(one(sql.get(text, params), "an agent upsert"));
    },
    async get(id) {
      return byId(id);
    },
    async list() {
      return sql.all(`SELECT * FROM ${t.agents} ORDER BY created_at, id`).map(agentFromRow);
    },
    async update(id, patch) {
      const changes = toRow("agents", agentPatch(patch ?? {}));
      if (Object.keys(changes).length === 0) return byId(id);
      const [set, params] = setList({ ...changes, updated_at: clock.nowIso() });
      const row = sql.get(`UPDATE ${t.agents} SET ${set} WHERE id = ? RETURNING *`, [...params, id]);
      return row ? agentFromRow(row) : null;
    },
  };
}

function sessionsRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["sessions"] {
  const byId = (id: Id) => {
    const row = sql.get(`SELECT * FROM ${t.sessions} WHERE id = ?`, [id]);
    return row ? sessionFromRow(row) : null;
  };
  return {
    async create(input) {
      const record = buildSession(input, pickId(input?.id, clock, "Session id"), clock.nowIso());
      const [text, params] = insertSql(t.sessions, toRow("sessions", record), "ON CONFLICT (id) DO NOTHING RETURNING *");
      const row = sql.get(text, params);
      if (!row) throw new StorageError(`A session with id "${record.id}" already exists.`);
      return sessionFromRow(row);
    },
    async get(id) {
      return byId(id);
    },
    async update(id, patch) {
      const changes = toRow("sessions", sessionPatch(patch ?? {}));
      if (Object.keys(changes).length === 0) return byId(id);
      const [set, params] = setList(changes);
      const row = sql.get(`UPDATE ${t.sessions} SET ${set} WHERE id = ? RETURNING *`, [...params, id]);
      return row ? sessionFromRow(row) : null;
    },
    async listByAgent(agentId, options) {
      const kind = options?.kind === undefined ? null : requireOneOf(options.kind, SESSION_KINDS, "Session kind");
      const limit = normalizeLimit(options?.limit, null);
      const [where, params] = whereAll([
        ["agent_id = ?", agentId],
        ["kind = ?", kind],
      ]);
      const rows = sql.all(`SELECT * FROM ${t.sessions} ${where} ORDER BY started_at DESC, ord DESC LIMIT ?`, [
        ...params,
        sqliteLimit(limit),
      ]);
      return rows.map(sessionFromRow);
    },
  };
}

function messagesRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["messages"] {
  return {
    async append(sessionId, input) {
      const id = requireId(sessionId, "Message sessionId");
      return sql.tx(() => {
        if (!sql.get(`SELECT 1 AS found FROM ${t.sessions} WHERE id = ?`, [id])) {
          throw new StorageError(`Cannot append a message: there is no session with id "${id}".`);
        }
        const next = one(sql.get(`SELECT coalesce(max(seq), -1) + 1 AS seq FROM ${t.messages} WHERE session_id = ?`, [id]), "the next seq");
        const record = buildMessage(id, input, clock.newId(), Number(next.seq), clock.nowIso());
        const [text, params] = insertSql(t.messages, toRow("messages", record), "RETURNING *");
        return messageFromRow(one(sql.get(text, params), "a message insert"));
      });
    },
    async list(sessionId) {
      return sql.all(`SELECT * FROM ${t.messages} WHERE session_id = ? ORDER BY seq`, [sessionId]).map(messageFromRow);
    },
    async get(id) {
      const row = sql.get(`SELECT * FROM ${t.messages} WHERE id = ?`, [id]);
      return row ? messageFromRow(row) : null;
    },
    async search(query, options) {
      const terms = searchTerms(query);
      const agentId = optionalId(options?.agentId, "Search agentId");
      const excludeSessionId = optionalId(options?.excludeSessionId, "Search excludeSessionId");
      const limit = normalizeLimit(options?.limit, DEFAULT_SEARCH_LIMIT);
      if (terms.length === 0 || limit === 0) return [];
      const rows = sql.all(
        `SELECT m.id, m.session_id, m.seq, m.role, m.created_at,
           snippet(${t.messages_fts}, 0, ?, ?, ?, ${SNIPPET_WORDS}) AS snippet,
           -bm25(${t.messages_fts}) AS score
         FROM ${t.messages_fts}
         JOIN ${t.messages} AS m ON m.ord = ${t.messages_fts}.rowid
         JOIN ${t.sessions} AS s ON s.id = m.session_id
         WHERE ${t.messages_fts} MATCH ?
           AND (? IS NULL OR s.agent_id = ?)
           AND (? IS NULL OR m.session_id <> ?)
         ORDER BY score DESC, m.created_at DESC, m.ord DESC
         LIMIT ?`,
        [
          SNIPPET_MARKS.start,
          SNIPPET_MARKS.end,
          SNIPPET_MARKS.ellipsis,
          ftsQuery(terms),
          agentId,
          agentId,
          excludeSessionId,
          excludeSessionId,
          sqliteLimit(limit),
        ],
      );
      return rows.map(searchHitFromRow);
    },
  };
}

function memoryRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["memory"] {
  const byKey = (agentId: Id, name: string) =>
    sql.get(`SELECT * FROM ${t.memory_stores} WHERE agent_id = ? AND name = ?`, [agentId, name]);
  return {
    async ensureStore(agentId, name, defaults) {
      const record = buildMemoryStore(agentId, name, defaults, clock.newId(), clock.nowIso());
      const [text, params] = insertSql(
        t.memory_stores,
        toRow("memory_stores", record),
        "ON CONFLICT (agent_id, name) DO NOTHING RETURNING *",
      );
      return memoryStoreFromRow(sql.tx(() => sql.get(text, params) ?? one(byKey(record.agentId, record.name), "a memory store")));
    },
    async getStore(agentId, name) {
      const row = byKey(agentId, name);
      return row ? memoryStoreFromRow(row) : null;
    },
    async listStores(agentId) {
      const rows = sql.all(`SELECT * FROM ${t.memory_stores} WHERE agent_id = ? ORDER BY name, id`, [agentId]);
      return rows.map(memoryStoreFromRow);
    },
    async writeContent(id, content, expectedVersion) {
      const text = requireText(content, "Memory store content");
      const expected = requireInteger(expectedVersion, "expectedVersion");
      const row = sql.get(
        `UPDATE ${t.memory_stores} SET content = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? RETURNING *`,
        [text, clock.nowIso(), id, expected],
      );
      return row ? memoryStoreFromRow(row) : null;
    },
    async setPolicy(id, policy) {
      const changes = toRow("memory_stores", memoryPolicy(policy ?? {}));
      if (Object.keys(changes).length === 0) {
        const row = sql.get(`SELECT * FROM ${t.memory_stores} WHERE id = ?`, [id]);
        return row ? memoryStoreFromRow(row) : null;
      }
      const [set, params] = setList({ ...changes, updated_at: clock.nowIso() });
      const row = sql.get(`UPDATE ${t.memory_stores} SET ${set} WHERE id = ? RETURNING *`, [...params, id]);
      return row ? memoryStoreFromRow(row) : null;
    },
  };
}

function skillsRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["skills"] {
  const updateOne = (id: Id, set: string, params: unknown[]) => {
    const row = sql.get(`UPDATE ${t.skills} SET ${set} WHERE id = ? RETURNING *`, [...params, id]);
    return row ? skillFromRow(row) : null;
  };
  return {
    async create(input) {
      const { skill, version } = buildSkill(input, clock.newId(), clock.nowIso());
      const [text, params] = insertSql(t.skills, skillToRow(skill), "ON CONFLICT (agent_id, name) DO NOTHING RETURNING *");
      return sql.tx(() => {
        const row = sql.get(text, params);
        if (!row) throw new StorageError(`A skill named "${skill.name}" already exists for agent "${skill.agentId}".`);
        sql.run(...insertSql(t.skill_versions, toRow("skill_versions", version)));
        return skillFromRow(row);
      });
    },
    async get(agentId, name) {
      const row = sql.get(`SELECT * FROM ${t.skills} WHERE agent_id = ? AND name = ?`, [agentId, name]);
      return row ? skillFromRow(row) : null;
    },
    async list(agentId, options) {
      const status = options?.status === undefined ? null : requireOneOf(options.status, SKILL_STATUSES, "Skill status");
      const [where, params] = whereAll([
        ["agent_id = ?", agentId],
        ["status = ?", status],
      ]);
      return sql.all(`SELECT * FROM ${t.skills} ${where} ORDER BY name, id`, params).map(skillFromRow);
    },
    async update(id, changeInput, metaInput) {
      const content = skillChange(changeInput);
      const meta = skillVersionMeta(metaInput);
      const at = clock.nowIso();
      return sql.tx(() => {
        const skill = updateOne(id, "description = ?, body = ?, version = version + 1, updated_at = ?", [
          content.description,
          content.body,
          at,
        ]);
        if (skill) {
          const version = { skillId: id, version: skill.version, ...content, createdAt: at, ...meta };
          sql.run(...insertSql(t.skill_versions, toRow("skill_versions", version)));
        }
        return skill;
      });
    },
    async setStatus(id, status) {
      return updateOne(id, "status = ?", [requireOneOf(status, SKILL_STATUSES, "Skill status")]);
    },
    async setPinned(id, pinned) {
      return updateOne(id, "pinned = ?", [requireBoolean(pinned, "Skill pinned")]);
    },
    async bump(id, counter, at) {
      // Safe to put in SQL: requireOneOf only lets the three fixed counter names through.
      const column = requireOneOf(counter, SKILL_COUNTERS, "Skill counter");
      const when = requireIso(at, "Skill bump at");
      sql.run(
        `UPDATE ${t.skills} SET ${column} = ${column} + 1,
           last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ? THEN ? ELSE last_used_at END
         WHERE id = ?`,
        [when, when, id],
      );
    },
    async versions(id) {
      const rows = sql.all(`SELECT * FROM ${t.skill_versions} WHERE skill_id = ? ORDER BY version`, [id]);
      return rows.map(skillVersionFromRow);
    },
  };
}

function proposalsRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["proposals"] {
  return {
    async create(input) {
      const record = buildProposal(input, pickId(input?.id, clock, "Proposal id"), clock.nowIso());
      const [text, params] = insertSql(t.proposals, toRow("proposals", record), "ON CONFLICT (id) DO NOTHING RETURNING *");
      const row = sql.get(text, params);
      if (!row) throw new StorageError(`A proposal with id "${record.id}" already exists.`);
      return proposalFromRow(row);
    },
    async get(id) {
      const row = sql.get(`SELECT * FROM ${t.proposals} WHERE id = ?`, [id]);
      return row ? proposalFromRow(row) : null;
    },
    async list(options) {
      const [where, params] = whereAll([
        ["agent_id = ?", optionalId(options?.agentId, "Proposal agentId")],
        ["session_id = ?", optionalId(options?.sessionId, "Proposal sessionId")],
        ["status = ?", options?.status === undefined ? null : requireOneOf(options.status, PROPOSAL_STATUSES, "Proposal status")],
        ["kind = ?", options?.kind === undefined ? null : requireOneOf(options.kind, PROPOSAL_KINDS, "Proposal kind")],
      ]);
      const limit = sqliteLimit(normalizeLimit(options?.limit, null));
      const rows = sql.all(`SELECT * FROM ${t.proposals} ${where} ORDER BY created_at DESC, ord DESC LIMIT ?`, [
        ...params,
        limit,
      ]);
      return rows.map(proposalFromRow);
    },
    async transition(id, from, to, decision) {
      const args = transitionArgs(from, to, decision);
      if (args.from.length === 0) return null;
      const note = args.note === undefined ? "" : ", decision_note = ?";
      const row = sql.get(
        `UPDATE ${t.proposals} SET status = ?, decided_at = ?, decided_by = ?${note}
         WHERE id = ? AND status IN (${args.from.map(() => "?").join(", ")}) RETURNING *`,
        [args.to, args.at, args.by, ...(args.note === undefined ? [] : [args.note]), id, ...args.from],
      );
      return row ? proposalFromRow(row) : null;
    },
    async setScore(id, score) {
      const next = requireOneOf(score, DRAFT_SCORES, "Proposal score");
      const row = sql.get(`UPDATE ${t.proposals} SET score = ? WHERE id = ? RETURNING *`, [next, id]);
      return row ? proposalFromRow(row) : null;
    },
  };
}

function auditRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["audit"] {
  // Append-only on purpose: there is no update or delete, and triggers refuse both in the database too.
  return {
    async append(entry) {
      const record = buildAudit(entry, pickId(entry?.id, clock, "Audit id"));
      const [text, params] = insertSql(t.audit, toRow("audit", record), "ON CONFLICT (id) DO NOTHING RETURNING *");
      const row = sql.get(text, params);
      if (!row) throw new StorageError(`An audit entry with id "${record.id}" already exists.`);
      return auditFromRow(row);
    },
    async list(options) {
      const [where, params] = whereAll([
        ["target = ?", optionalText(options?.target, "Audit target filter")],
        ["actor = ?", optionalText(options?.actor, "Audit actor filter")],
        ["action = ?", optionalText(options?.action, "Audit action filter")],
      ]);
      const limit = sqliteLimit(normalizeLimit(options?.limit, null));
      const rows = sql.all(`SELECT * FROM ${t.audit} ${where} ORDER BY at DESC, ord DESC LIMIT ?`, [...params, limit]);
      return rows.map(auditFromRow);
    },
  };
}

function costsRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["costs"] {
  return {
    async add(input) {
      const record = buildCost(input, pickId(input?.id, clock, "Cost id"));
      const [text, params] = insertSql(t.costs, toRow("costs", record), "ON CONFLICT (id) DO NOTHING RETURNING *");
      const row = sql.get(text, params);
      if (!row) throw new StorageError(`A cost record with id "${record.id}" already exists.`);
      return costFromRow(row);
    },
    async sum(options) {
      const agentId = requireId(options?.agentId, "Cost sum agentId");
      const since = requireIso(options?.since, "Cost sum since");
      const row = sql.get(`SELECT coalesce(sum(cost_usd), 0.0) AS total FROM ${t.costs} WHERE agent_id = ? AND at >= ?`, [
        agentId,
        since,
      ]);
      return Number(row?.total ?? 0);
    },
    async list(options) {
      const [where, params] = whereAll([
        ["agent_id = ?", optionalId(options?.agentId, "Cost agentId")],
        ["session_id = ?", optionalId(options?.sessionId, "Cost sessionId")],
      ]);
      const limit = sqliteLimit(normalizeLimit(options?.limit, null));
      const rows = sql.all(`SELECT * FROM ${t.costs} ${where} ORDER BY at DESC, ord DESC LIMIT ?`, [...params, limit]);
      return rows.map(costFromRow);
    },
  };
}

function jobsRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["jobs"] {
  const byId = (id: Id) => {
    const row = sql.get(`SELECT * FROM ${t.jobs} WHERE id = ?`, [id]);
    return row ? jobFromRow(row) : null;
  };
  const byName = (agentId: Id, name: string) => {
    const row = sql.get(`SELECT * FROM ${t.jobs} WHERE agent_id = ? AND name = ?`, [agentId, name]);
    return row ? jobFromRow(row) : null;
  };
  const updateOne = (id: Id, changes: Row) => {
    const [set, params] = setList(changes);
    const row = sql.get(`UPDATE ${t.jobs} SET ${set} WHERE id = ? RETURNING *`, [...params, id]);
    return row ? jobFromRow(row) : null;
  };
  return {
    async upsert(input) {
      const fields = jobFields(input);
      const givenId = input.id === undefined ? null : requireId(input.id, "Job id");
      return sql.tx(() => {
        const existing = givenId === null ? byName(fields.agentId, fields.name) : byId(givenId);
        const id = existing?.id ?? givenId ?? clock.newId();
        const clash = byName(fields.agentId, fields.name);
        if (clash && clash.id !== id) {
          throw new StorageError(`A job named "${fields.name}" already exists for agent "${fields.agentId}".`);
        }
        if (existing) return must(updateOne(id, toRow("jobs", fields)), "a job update");
        const [text, params] = insertSql(t.jobs, toRow("jobs", buildJob(input, id)), "RETURNING *");
        return jobFromRow(one(sql.get(text, params), "a job insert"));
      });
    },
    async get(id) {
      return byId(id);
    },
    async list(options) {
      const [where, params] = whereAll([["agent_id = ?", optionalId(options?.agentId, "Job agentId")]]);
      return sql.all(`SELECT * FROM ${t.jobs} ${where} ORDER BY name, id`, params).map(jobFromRow);
    },
    async claimDue(now, options) {
      const args = claimArgs(now, options);
      const rows = sql.tx(() =>
        sql.all(
          `UPDATE ${t.jobs} SET locked_until = ?, locked_by = ?
           WHERE id IN (
             SELECT id FROM ${t.jobs}
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
               AND (locked_until IS NULL OR locked_until <= ?)
             ORDER BY next_run_at, id
             LIMIT ?
           )
           RETURNING *`,
          [args.lockedUntil, args.worker, args.now, args.now, args.limit],
        ),
      );
      const jobs = rows.map(jobFromRow);
      return jobs.sort((a, b) => compareText(a.nextRunAt ?? "", b.nextRunAt ?? "") || compareText(a.id, b.id));
    },
    async finish(id, outcome) {
      return updateOne(id, { ...toRow("jobs", jobOutcome(outcome)), locked_until: null, locked_by: null });
    },
    async setEnabled(id, enabled) {
      return updateOne(id, { enabled: requireBoolean(enabled, "Job enabled") });
    },
  };
}

function deliveriesRepo(sql: Sql, t: SqliteTables, clock: Clock): Storage["deliveries"] {
  return {
    async add(input) {
      const record = buildDelivery(input, pickId(input?.id, clock, "Delivery id"), clock.nowIso());
      const [text, params] = insertSql(t.deliveries, toRow("deliveries", record), "ON CONFLICT (id) DO NOTHING RETURNING *");
      const row = sql.get(text, params);
      if (!row) throw new StorageError(`A delivery with id "${record.id}" already exists.`);
      return deliveryFromRow(row);
    },
    async mark(id, status, error) {
      const next = requireOneOf(status, DELIVERY_STATUSES, "Delivery status");
      const row = sql.get(`UPDATE ${t.deliveries} SET status = ?, error = ? WHERE id = ? RETURNING *`, [
        next,
        optionalText(error, "Delivery error"),
        id,
      ]);
      return row ? deliveryFromRow(row) : null;
    },
    async list(options) {
      const [where, params] = whereAll([
        ["target = ?", optionalText(options?.target, "Delivery target filter")],
        ["channel = ?", optionalText(options?.channel, "Delivery channel filter")],
        ["created_at >= ?", optionalIso(options?.since, "Delivery since")],
      ]);
      const limit = sqliteLimit(normalizeLimit(options?.limit, null));
      const rows = sql.all(`SELECT * FROM ${t.deliveries} ${where} ORDER BY created_at DESC, ord DESC LIMIT ?`, [
        ...params,
        limit,
      ]);
      return rows.map(deliveryFromRow);
    },
  };
}
