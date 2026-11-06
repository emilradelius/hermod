/**
 * The Postgres schema: a validated schema name, column types, the JSON row expression every query returns, and
 * versioned migrations.
 *
 * Conventions: everything lives in one schema (default "hermod"), always schema-qualified and quoted; JSON is jsonb;
 * whole numbers are bigint (the record builders allow any safe integer); times are timestamptz and are returned as ISO
 * strings in toISOString() format (UTC, milliseconds); text sorts use
 * COLLATE "C" (code point order, the same as SQLite). Row level security is enabled on every table with no policies:
 * writing policies is the app's job (the owner role that runs the adapter bypasses RLS; other roles see nothing).
 *
 * Search: messages keep `search_text`, the text's words lowercased with Latin diacritics removed (built in JS, see
 * buildSearchText), because the 'simple' configuration does not fold diacritics; `search_tsv` is a generated
 * to_tsvector('simple', search_text) column with a GIN index.
 *
 * migrate() runs one DO block: one transaction, serialized by an advisory lock, so concurrent migrations are safe and
 * a failed migration leaves nothing half-done.
 */
import { StorageError } from "./common.js";
import type { TableName } from "./rows.js";

export const POSTGRES_DEFAULT_SCHEMA = "hermod";

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** A schema name is 1–63 lowercase letters, digits or underscores, not starting with a digit or "pg_". */
export function validatePostgresSchema(schema: unknown): string {
  if (typeof schema === "string" && SCHEMA_PATTERN.test(schema) && !schema.startsWith("pg_")) return schema;
  throw new StorageError(
    `The Postgres schema name must match ^[a-z_][a-z0-9_]{0,62}$ and not start with "pg_"; got ${JSON.stringify(schema)}.`,
  );
}

export type PgKind = "text" | "int" | "float" | "bool" | "json" | "time";

/** The columns every query reads (and that records are written to), with their types. */
export const PG_COLUMNS: Record<TableName, Record<string, PgKind>> = {
  agents: {
    id: "text",
    name: "text",
    mode: "text",
    accuracy_bar: "float",
    min_samples: "int",
    monthly_cost_cap_usd: "float",
    created_at: "time",
    updated_at: "time",
  },
  sessions: {
    id: "text",
    agent_id: "text",
    kind: "text",
    parent_id: "text",
    attended: "bool",
    started_at: "time",
    ended_at: "time",
    status: "text",
    memory_snapshot: "text",
    skills_index: "text",
    counters: "json",
    meta: "json",
  },
  messages: {
    id: "text",
    session_id: "text",
    seq: "int",
    role: "text",
    content: "json",
    text: "text",
    created_at: "time",
  },
  memory_stores: {
    id: "text",
    agent_id: "text",
    name: "text",
    cap_chars: "int",
    auto_apply: "text",
    content: "text",
    version: "int",
    updated_at: "time",
  },
  skills: {
    id: "text",
    agent_id: "text",
    name: "text",
    description: "text",
    body: "text",
    version: "int",
    status: "text",
    pinned: "bool",
    created_at: "time",
    updated_at: "time",
    last_used_at: "time",
    views: "int",
    uses: "int",
    patches: "int",
  },
  skill_versions: {
    skill_id: "text",
    version: "int",
    description: "text",
    body: "text",
    created_at: "time",
    created_by: "text",
    proposal_id: "text",
  },
  proposals: {
    id: "text",
    agent_id: "text",
    session_id: "text",
    kind: "text",
    target: "text",
    payload: "json",
    evidence: "json",
    rationale: "text",
    status: "text",
    created_by: "text",
    created_at: "time",
    decided_at: "time",
    decided_by: "text",
    decision_note: "text",
    score: "text",
    shadow: "bool",
  },
  audit: { id: "text", at: "time", actor: "text", action: "text", target: "text", details: "json" },
  costs: {
    id: "text",
    at: "time",
    agent_id: "text",
    session_id: "text",
    model: "text",
    purpose: "text",
    input_tokens: "int",
    output_tokens: "int",
    cache_read_tokens: "int",
    cache_write_tokens: "int",
    cost_usd: "float",
  },
  jobs: {
    id: "text",
    agent_id: "text",
    name: "text",
    schedule: "text",
    time_zone: "text",
    prompt: "text",
    skills: "json",
    pre_step: "text",
    deliver: "text",
    enabled: "bool",
    next_run_at: "time",
    last_run_at: "time",
    last_status: "text",
    last_error: "text",
    failures: "int",
    locked_until: "time",
    locked_by: "text",
  },
  deliveries: {
    id: "text",
    channel: "text",
    target: "text",
    title: "text",
    body: "text",
    url: "text",
    created_at: "time",
    status: "text",
    error: "text",
    job_id: "text",
  },
};

/** Columns that are written but never read back into a record (the folded search text of a message). */
export const PG_WRITE_ONLY_COLUMNS: Partial<Record<TableName, Record<string, PgKind>>> = {
  messages: { search_text: "text" },
};

/** The type of a column the adapter writes; throws for a column the schema does not have. */
export function pgColumnKind(table: TableName, column: string): PgKind {
  const kind = PG_COLUMNS[table][column] ?? PG_WRITE_ONLY_COLUMNS[table]?.[column];
  if (kind === undefined) throw new StorageError(`The Postgres table "${table}" has no column "${column}".`);
  return kind;
}

/** Explicit casts on every parameter, so neither driver has to guess a type (JSON and times travel as text). */
export const PG_CAST: Record<PgKind, string> = {
  text: "::text",
  int: "::bigint",
  float: "::float8",
  bool: "::boolean",
  json: "::text::jsonb",
  time: "::text::timestamptz",
};

/** An ISO string in toISOString() format for a timestamptz expression. */
export function pgIso(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * The whole row of `table` (alias `alias`) as one JSON text value. Every query returns rows this way, so the
 * adapter does not depend on how a driver names columns or parses types: JSON columns arrive as JSON text, times as
 * ISO strings, booleans as true/false.
 */
export function pgRowJson(table: TableName, alias: string): string {
  const fields = Object.entries(PG_COLUMNS[table]).map(([column, kind]) => {
    const ref = `${alias}.${column}`;
    const value = kind === "json" ? `${ref}::text` : kind === "time" ? pgIso(ref) : ref;
    return `'${column}', ${value}`;
  });
  return `json_build_object(${fields.join(", ")})::text`;
}

export type PgTables = Record<TableName | "migrations", string>;

/** Schema-qualified, quoted table names, e.g. "hermod"."agents". */
export function pgTables(schema: string): PgTables {
  const name = (table: string) => `"${schema}"."${table}"`;
  return {
    agents: name("agents"),
    sessions: name("sessions"),
    messages: name("messages"),
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

export interface PgMigration {
  version: number;
  name: string;
  /** The statements of this version (each ending in ";"), run inside the migration DO block. */
  sql(schema: string): string;
}

const RLS_NOTE = "Row level security is enabled with no policies: writing policies is the app''s job.";

function rlsAndComment(table: string, what: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    COMMENT ON TABLE ${table} IS 'Hermod ${what}. ${RLS_NOTE}';`;
}

function initialSchema(schema: string): string {
  const t = pgTables(schema);
  const s = `"${schema}"`;
  return `
    CREATE TABLE ${t.agents} (
      id text PRIMARY KEY,
      name text NOT NULL,
      mode text NOT NULL,
      accuracy_bar double precision NOT NULL,
      min_samples bigint NOT NULL,
      monthly_cost_cap_usd double precision,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    ${rlsAndComment(t.agents, "agents")}

    CREATE TABLE ${t.sessions} (
      ord bigint GENERATED ALWAYS AS IDENTITY,
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      kind text NOT NULL,
      parent_id text,
      attended boolean NOT NULL,
      started_at timestamptz NOT NULL,
      ended_at timestamptz,
      status text NOT NULL,
      memory_snapshot text NOT NULL,
      skills_index text NOT NULL,
      counters jsonb NOT NULL,
      meta jsonb NOT NULL,
      next_seq bigint NOT NULL DEFAULT 0
    );
    CREATE INDEX sessions_agent_started ON ${t.sessions} (agent_id, started_at DESC, ord DESC);
    ${rlsAndComment(t.sessions, "sessions (memory snapshot and skills index frozen at start; next_seq numbers messages)")}

    CREATE TABLE ${t.messages} (
      ord bigint GENERATED ALWAYS AS IDENTITY,
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES ${t.sessions} (id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      role text NOT NULL,
      content jsonb NOT NULL,
      text text NOT NULL,
      search_text text NOT NULL,
      search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
      created_at timestamptz NOT NULL,
      UNIQUE (session_id, seq)
    );
    CREATE INDEX messages_search ON ${t.messages} USING gin (search_tsv);
    ${rlsAndComment(t.messages, "messages, append-only (search_text holds the folded words that search_tsv indexes)")}

    CREATE TABLE ${t.memory_stores} (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      name text NOT NULL,
      cap_chars bigint NOT NULL,
      auto_apply text NOT NULL,
      content text NOT NULL,
      version bigint NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (agent_id, name)
    );
    ${rlsAndComment(t.memory_stores, "memory stores (version is checked on every write)")}

    CREATE TABLE ${t.skills} (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL,
      body text NOT NULL,
      version bigint NOT NULL,
      status text NOT NULL,
      pinned boolean NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      last_used_at timestamptz,
      views bigint NOT NULL,
      uses bigint NOT NULL,
      patches bigint NOT NULL,
      UNIQUE (agent_id, name)
    );
    ${rlsAndComment(t.skills, "skills (never deleted; archived instead)")}

    CREATE TABLE ${t.skill_versions} (
      skill_id text NOT NULL REFERENCES ${t.skills} (id) ON DELETE CASCADE,
      version bigint NOT NULL,
      description text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL,
      created_by text NOT NULL,
      proposal_id text,
      PRIMARY KEY (skill_id, version)
    );
    ${rlsAndComment(t.skill_versions, "skill versions, one row per change")}

    CREATE TABLE ${t.proposals} (
      ord bigint GENERATED ALWAYS AS IDENTITY,
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      session_id text,
      kind text NOT NULL,
      target text NOT NULL,
      payload jsonb NOT NULL,
      evidence jsonb NOT NULL,
      rationale text NOT NULL,
      status text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL,
      decided_at timestamptz,
      decided_by text,
      decision_note text,
      score text,
      shadow boolean NOT NULL
    );
    CREATE INDEX proposals_agent_created ON ${t.proposals} (agent_id, created_at DESC);
    CREATE INDEX proposals_status_created ON ${t.proposals} (status, created_at DESC);
    ${rlsAndComment(t.proposals, "proposals (the review inbox)")}

    CREATE TABLE ${t.audit} (
      ord bigint GENERATED ALWAYS AS IDENTITY,
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      actor text NOT NULL,
      action text NOT NULL,
      target text NOT NULL,
      details jsonb NOT NULL
    );
    CREATE INDEX audit_at ON ${t.audit} (at DESC, ord DESC);
    CREATE INDEX audit_target_at ON ${t.audit} (target, at DESC);
    CREATE FUNCTION ${s}.audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'Audit entries are append-only: % is not allowed.', TG_OP;
    END
    $fn$;
    CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON ${t.audit}
      FOR EACH ROW EXECUTE FUNCTION ${s}.audit_append_only();
    CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON ${t.audit}
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.audit_append_only();
    ${rlsAndComment(t.audit, "audit log, append-only (triggers refuse UPDATE, DELETE and TRUNCATE)")}

    CREATE TABLE ${t.costs} (
      ord bigint GENERATED ALWAYS AS IDENTITY,
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      agent_id text NOT NULL,
      session_id text,
      model text NOT NULL,
      purpose text NOT NULL,
      input_tokens bigint NOT NULL,
      output_tokens bigint NOT NULL,
      cache_read_tokens bigint NOT NULL,
      cache_write_tokens bigint NOT NULL,
      cost_usd double precision NOT NULL
    );
    CREATE INDEX costs_agent_at ON ${t.costs} (agent_id, at);
    ${rlsAndComment(t.costs, "model call costs")}

    CREATE TABLE ${t.jobs} (
      id text PRIMARY KEY,
      agent_id text NOT NULL,
      name text NOT NULL,
      schedule text NOT NULL,
      time_zone text NOT NULL,
      prompt text NOT NULL,
      skills jsonb NOT NULL,
      pre_step text,
      deliver text NOT NULL,
      enabled boolean NOT NULL,
      next_run_at timestamptz,
      last_run_at timestamptz,
      last_status text,
      last_error text,
      failures bigint NOT NULL,
      locked_until timestamptz,
      locked_by text,
      UNIQUE (agent_id, name)
    );
    CREATE INDEX jobs_due ON ${t.jobs} (next_run_at) WHERE enabled;
    ${rlsAndComment(t.jobs, "scheduled jobs (claimed with a lease)")}

    CREATE TABLE ${t.deliveries} (
      ord bigint GENERATED ALWAYS AS IDENTITY,
      id text PRIMARY KEY,
      channel text NOT NULL,
      target text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      url text,
      created_at timestamptz NOT NULL,
      status text NOT NULL,
      error text,
      job_id text
    );
    CREATE INDEX deliveries_target_created ON ${t.deliveries} (target, created_at DESC);
    ${rlsAndComment(t.deliveries, "deliveries (outbox)")}
  `;
}

/** Applied in order; each version runs once (recorded in <schema>.migrations). Never edit a released version. */
export const PG_MIGRATIONS: readonly PgMigration[] = [{ version: 1, name: "initial schema", sql: initialSchema }];

/**
 * One DO block that creates the schema and the migrations table if missing and applies every pending migration,
 * in one transaction, under an advisory lock (two concurrent migrate() calls wait for each other). Idempotent.
 */
export function pgMigrateSql(schema: string, migrations: readonly PgMigration[] = PG_MIGRATIONS): string {
  const t = pgTables(schema);
  const literal = `'${schema}'`;
  const steps = migrations.map(
    (m) => `
  IF NOT EXISTS (SELECT 1 FROM ${t.migrations} WHERE version = ${m.version}) THEN
    ${m.sql(schema)}
    INSERT INTO ${t.migrations} (version, name) VALUES (${m.version}, '${m.name.replaceAll("'", "''")}');
  END IF;`,
  );
  return `DO $hermod$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hermod-migrate'), hashtext(${literal}));
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${literal}) THEN
    CREATE SCHEMA "${schema}";
    COMMENT ON SCHEMA "${schema}" IS 'Hermod runtime tables. ${RLS_NOTE}';
  END IF;
  IF to_regclass('${t.migrations.replaceAll("'", "''")}') IS NULL THEN
    CREATE TABLE ${t.migrations} (
      version bigint PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    ${rlsAndComment(t.migrations, "schema migrations, one row per applied version")}
  END IF;${steps.join("")}
END
$hermod$`;
}
