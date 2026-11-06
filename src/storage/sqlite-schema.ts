/**
 * The SQLite schema: table names under a prefix and versioned migrations.
 *
 * Conventions: STRICT tables; JSON as TEXT (JSON.stringify / JSON.parse); booleans as INTEGER 0/1; times as ISO TEXT
 * in toISOString() format (so they sort as text); string literals in single quotes (better-sqlite3 builds SQLite
 * with SQLITE_DQS=0); identifiers in double quotes. Tables that are listed newest first have an
 * `ord INTEGER PRIMARY KEY` (a stable rowid) that breaks ties between equal times. Message text is indexed by an
 * FTS5 external-content table (`unicode61 remove_diacritics 2`) kept in sync by triggers.
 */
import { StorageError } from "./common.js";
import type { TableName } from "./rows.js";

export const SQLITE_DEFAULT_PREFIX = "hermod_";

const PREFIX_PATTERN = /^[a-z_][a-z0-9_]{0,47}$/;

/** A table prefix is 1–48 characters: lowercase letters, digits and underscores, not starting with a digit. */
export function validateSqlitePrefix(prefix: unknown): string {
  if (typeof prefix === "string" && PREFIX_PATTERN.test(prefix)) return prefix;
  throw new StorageError(
    `The SQLite table prefix must be 1–48 lowercase letters, digits or underscores, not starting with a digit; got ${JSON.stringify(prefix)}.`,
  );
}

export type SqliteTables = Record<TableName | "messages_fts" | "migrations", string>;

/** Quoted table names for a prefix, e.g. agents → "hermod_agents". */
export function sqliteTables(prefix: string): SqliteTables {
  const name = (table: string) => `"${prefix}${table}"`;
  return {
    agents: name("agents"),
    sessions: name("sessions"),
    messages: name("messages"),
    messages_fts: name("messages_fts"),
    memory_stores: name("memory_stores"),
    skills: name("skills"),
    skill_versions: name("skill_versions"),
    proposals: name("proposals"),
    audit: name("audit"),
    costs: name("costs"),
    jobs: name("jobs"),
    deliveries: name("deliveries"),
    migrations: name("migrations"),
  };
}

export interface SqliteMigration {
  version: number;
  name: string;
  /** The SQL for this version (several statements), for a validated prefix. */
  sql(prefix: string): string;
}

export function sqliteMigrationsTable(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS "${prefix}migrations" (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;`;
}

function initialSchema(p: string): string {
  const t = sqliteTables(p);
  // Index and trigger names are global in a SQLite database, so they carry the prefix too.
  return `
CREATE TABLE IF NOT EXISTS ${t.agents} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  accuracy_bar REAL NOT NULL,
  min_samples INTEGER NOT NULL,
  monthly_cost_cap_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ${t.sessions} (
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id TEXT,
  attended INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  memory_snapshot TEXT NOT NULL,
  skills_index TEXT NOT NULL,
  counters TEXT NOT NULL,
  meta TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS "${p}sessions_agent" ON ${t.sessions} (agent_id, started_at);

CREATE TABLE IF NOT EXISTS ${t.messages} (
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES ${t.sessions} (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS ${t.messages_fts} USING fts5(
  text,
  content = '${p}messages',
  content_rowid = 'ord',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS "${p}messages_fts_insert" AFTER INSERT ON ${t.messages} BEGIN
  INSERT INTO ${t.messages_fts} (rowid, text) VALUES (new.ord, new.text);
END;
CREATE TRIGGER IF NOT EXISTS "${p}messages_fts_delete" AFTER DELETE ON ${t.messages} BEGIN
  INSERT INTO ${t.messages_fts} (${t.messages_fts}, rowid, text) VALUES ('delete', old.ord, old.text);
END;
CREATE TRIGGER IF NOT EXISTS "${p}messages_fts_update" AFTER UPDATE ON ${t.messages} BEGIN
  INSERT INTO ${t.messages_fts} (${t.messages_fts}, rowid, text) VALUES ('delete', old.ord, old.text);
  INSERT INTO ${t.messages_fts} (rowid, text) VALUES (new.ord, new.text);
END;

CREATE TABLE IF NOT EXISTS ${t.memory_stores} (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cap_chars INTEGER NOT NULL,
  auto_apply TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, name)
) STRICT;

CREATE TABLE IF NOT EXISTS ${t.skills} (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  views INTEGER NOT NULL,
  uses INTEGER NOT NULL,
  patches INTEGER NOT NULL,
  UNIQUE (agent_id, name)
) STRICT;

CREATE TABLE IF NOT EXISTS ${t.skill_versions} (
  skill_id TEXT NOT NULL REFERENCES ${t.skills} (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  proposal_id TEXT,
  PRIMARY KEY (skill_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS ${t.proposals} (
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  evidence TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  score TEXT,
  shadow INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS "${p}proposals_agent" ON ${t.proposals} (agent_id, created_at);
CREATE INDEX IF NOT EXISTS "${p}proposals_status" ON ${t.proposals} (status, created_at);

CREATE TABLE IF NOT EXISTS ${t.audit} (
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS "${p}audit_at" ON ${t.audit} (at);
CREATE INDEX IF NOT EXISTS "${p}audit_target" ON ${t.audit} (target, at);
CREATE TRIGGER IF NOT EXISTS "${p}audit_no_update" BEFORE UPDATE ON ${t.audit} BEGIN
  SELECT RAISE(ABORT, 'Audit entries are append-only: they cannot be updated.');
END;
CREATE TRIGGER IF NOT EXISTS "${p}audit_no_delete" BEFORE DELETE ON ${t.audit} BEGIN
  SELECT RAISE(ABORT, 'Audit entries are append-only: they cannot be deleted.');
END;

CREATE TABLE IF NOT EXISTS ${t.costs} (
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS "${p}costs_agent_at" ON ${t.costs} (agent_id, at);

CREATE TABLE IF NOT EXISTS ${t.jobs} (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  prompt TEXT NOT NULL,
  skills TEXT NOT NULL,
  pre_step TEXT,
  deliver TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  failures INTEGER NOT NULL,
  locked_until TEXT,
  locked_by TEXT,
  UNIQUE (agent_id, name)
) STRICT;
CREATE INDEX IF NOT EXISTS "${p}jobs_due" ON ${t.jobs} (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS ${t.deliveries} (
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  job_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "${p}deliveries_target" ON ${t.deliveries} (target, created_at);
`;
}

/** Applied in order; each version runs once (recorded in <prefix>migrations). Never edit a released version. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [{ version: 1, name: "initial schema", sql: initialSchema }];
