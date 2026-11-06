/**
 * Records ↔ SQL rows, shared by the SQLite and Postgres adapters. Rows use snake_case columns; JSON columns travel
 * as JSON text, times as ISO strings, booleans as true/false (Postgres) or 1/0 (SQLite).
 */
import type {
  AgentRecord,
  AuditRecord,
  CostRecord,
  DeliveryRecord,
  JobRecord,
  MemoryStoreRecord,
  MessageRecord,
  ProposalRecord,
  SearchHit,
  SessionRecord,
  SkillRecord,
  SkillVersionRecord,
} from "../types.js";
import {
  AGENT_MODES,
  AUTO_APPLY,
  CALL_PURPOSES,
  DELIVERY_STATUSES,
  DRAFT_SCORES,
  JOB_STATUSES,
  MESSAGE_ROLES,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  SESSION_KINDS,
  SESSION_STATUSES,
  SKILL_STATUSES,
  StorageError,
  toJsonText,
  toSnake,
} from "./common.js";

export type Row = Record<string, unknown>;

// ─── Reading columns ────────────────────────────────────────────────────────────────────────────────────────

function unexpected(column: string, value: unknown): StorageError {
  return new StorageError(`The database returned an unexpected value in column "${column}": ${String(value)}.`);
}

function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw unexpected(column, value);
  return value;
}

function strOrNull(row: Row, column: string): string | null {
  return row[column] === null || row[column] === undefined ? null : str(row, column);
}

/** Numbers may come back as number, bigint (better-sqlite3 safeIntegers) or numeric text (Postgres bigint). */
function num(row: Row, column: string): number {
  const value = row[column];
  const n =
    typeof value === "number"
      ? value
      : typeof value === "bigint" || (typeof value === "string" && value.trim() !== "")
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) throw unexpected(column, value);
  return n;
}

function numOrNull(row: Row, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : num(row, column);
}

function bool(row: Row, column: string): boolean {
  const value = row[column];
  if (value === true || value === 1 || value === 1n) return true;
  if (value === false || value === 0 || value === 0n) return false;
  throw unexpected(column, value);
}

function json<T>(row: Row, column: string): T {
  try {
    return JSON.parse(str(row, column)) as T;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw unexpected(column, row[column]);
  }
}

function oneOf<T extends string>(row: Row, column: string, allowed: readonly T[]): T {
  const value = str(row, column);
  if (!(allowed as readonly string[]).includes(value)) throw unexpected(column, value);
  return value as T;
}

function oneOfOrNull<T extends string>(row: Row, column: string, allowed: readonly T[]): T | null {
  return row[column] === null || row[column] === undefined ? null : oneOf(row, column, allowed);
}

// ─── Rows → records ─────────────────────────────────────────────────────────────────────────────────────────

export function agentFromRow(row: Row): AgentRecord {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    mode: oneOf(row, "mode", AGENT_MODES),
    accuracyBar: num(row, "accuracy_bar"),
    minSamples: num(row, "min_samples"),
    monthlyCostCapUsd: numOrNull(row, "monthly_cost_cap_usd"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

export function sessionFromRow(row: Row): SessionRecord {
  return {
    id: str(row, "id"),
    agentId: str(row, "agent_id"),
    kind: oneOf(row, "kind", SESSION_KINDS),
    parentId: strOrNull(row, "parent_id"),
    attended: bool(row, "attended"),
    startedAt: str(row, "started_at"),
    endedAt: strOrNull(row, "ended_at"),
    status: oneOf(row, "status", SESSION_STATUSES),
    memorySnapshot: str(row, "memory_snapshot"),
    skillsIndex: str(row, "skills_index"),
    counters: json(row, "counters"),
    meta: json(row, "meta"),
  };
}

export function messageFromRow(row: Row): MessageRecord {
  return {
    id: str(row, "id"),
    sessionId: str(row, "session_id"),
    seq: num(row, "seq"),
    role: oneOf(row, "role", MESSAGE_ROLES),
    content: json(row, "content"),
    text: str(row, "text"),
    createdAt: str(row, "created_at"),
  };
}

export function memoryStoreFromRow(row: Row): MemoryStoreRecord {
  return {
    id: str(row, "id"),
    agentId: str(row, "agent_id"),
    name: str(row, "name"),
    capChars: num(row, "cap_chars"),
    autoApply: oneOf(row, "auto_apply", AUTO_APPLY),
    content: str(row, "content"),
    version: num(row, "version"),
    updatedAt: str(row, "updated_at"),
  };
}

export function skillFromRow(row: Row): SkillRecord {
  return {
    id: str(row, "id"),
    agentId: str(row, "agent_id"),
    name: str(row, "name"),
    description: str(row, "description"),
    body: str(row, "body"),
    version: num(row, "version"),
    status: oneOf(row, "status", SKILL_STATUSES),
    pinned: bool(row, "pinned"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    lastUsedAt: strOrNull(row, "last_used_at"),
    counters: { views: num(row, "views"), uses: num(row, "uses"), patches: num(row, "patches") },
  };
}

export function skillVersionFromRow(row: Row): SkillVersionRecord {
  return {
    skillId: str(row, "skill_id"),
    version: num(row, "version"),
    description: str(row, "description"),
    body: str(row, "body"),
    createdAt: str(row, "created_at"),
    createdBy: str(row, "created_by"),
    proposalId: strOrNull(row, "proposal_id"),
  };
}

export function proposalFromRow(row: Row): ProposalRecord {
  return {
    id: str(row, "id"),
    agentId: str(row, "agent_id"),
    sessionId: strOrNull(row, "session_id"),
    kind: oneOf(row, "kind", PROPOSAL_KINDS),
    target: str(row, "target"),
    payload: json(row, "payload"),
    evidence: json(row, "evidence"),
    rationale: str(row, "rationale"),
    status: oneOf(row, "status", PROPOSAL_STATUSES),
    createdBy: str(row, "created_by"),
    createdAt: str(row, "created_at"),
    decidedAt: strOrNull(row, "decided_at"),
    decidedBy: strOrNull(row, "decided_by"),
    decisionNote: strOrNull(row, "decision_note"),
    score: oneOfOrNull(row, "score", DRAFT_SCORES),
    shadow: bool(row, "shadow"),
  };
}

export function auditFromRow(row: Row): AuditRecord {
  return {
    id: str(row, "id"),
    at: str(row, "at"),
    actor: str(row, "actor"),
    action: str(row, "action"),
    target: str(row, "target"),
    details: json(row, "details"),
  };
}

export function costFromRow(row: Row): CostRecord {
  return {
    id: str(row, "id"),
    at: str(row, "at"),
    agentId: str(row, "agent_id"),
    sessionId: strOrNull(row, "session_id"),
    model: str(row, "model"),
    purpose: oneOf(row, "purpose", CALL_PURPOSES),
    inputTokens: num(row, "input_tokens"),
    outputTokens: num(row, "output_tokens"),
    cacheReadTokens: num(row, "cache_read_tokens"),
    cacheWriteTokens: num(row, "cache_write_tokens"),
    costUsd: num(row, "cost_usd"),
  };
}

export function jobFromRow(row: Row): JobRecord {
  return {
    id: str(row, "id"),
    agentId: str(row, "agent_id"),
    name: str(row, "name"),
    schedule: str(row, "schedule"),
    timeZone: str(row, "time_zone"),
    prompt: str(row, "prompt"),
    skills: json(row, "skills"),
    preStep: strOrNull(row, "pre_step"),
    deliver: str(row, "deliver"),
    enabled: bool(row, "enabled"),
    nextRunAt: strOrNull(row, "next_run_at"),
    lastRunAt: strOrNull(row, "last_run_at"),
    lastStatus: oneOfOrNull(row, "last_status", JOB_STATUSES),
    lastError: strOrNull(row, "last_error"),
    failures: num(row, "failures"),
    lockedUntil: strOrNull(row, "locked_until"),
    lockedBy: strOrNull(row, "locked_by"),
  };
}

export function deliveryFromRow(row: Row): DeliveryRecord {
  return {
    id: str(row, "id"),
    channel: str(row, "channel"),
    target: str(row, "target"),
    title: str(row, "title"),
    body: str(row, "body"),
    url: strOrNull(row, "url"),
    createdAt: str(row, "created_at"),
    status: oneOf(row, "status", DELIVERY_STATUSES),
    error: strOrNull(row, "error"),
    jobId: strOrNull(row, "job_id"),
  };
}

/** A search row: the message's id, session_id, seq, role and created_at, plus snippet and score columns. */
export function searchHitFromRow(row: Row): SearchHit {
  return {
    sessionId: str(row, "session_id"),
    messageId: str(row, "id"),
    seq: num(row, "seq"),
    role: oneOf(row, "role", MESSAGE_ROLES),
    snippet: str(row, "snippet"),
    score: num(row, "score"),
    createdAt: str(row, "created_at"),
  };
}

// ─── Records → rows ─────────────────────────────────────────────────────────────────────────────────────────

export const TABLES = [
  "agents",
  "sessions",
  "messages",
  "memory_stores",
  "skills",
  "skill_versions",
  "proposals",
  "audit",
  "costs",
  "jobs",
  "deliveries",
] as const;
export type TableName = (typeof TABLES)[number];

/** Per table, the record fields stored as JSON text. */
const JSON_FIELDS: Partial<Record<TableName, readonly string[]>> = {
  sessions: ["counters", "meta"],
  messages: ["content"],
  proposals: ["payload", "evidence"],
  audit: ["details"],
  jobs: ["skills"],
};
const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * A record or patch as a row of `table`: snake_case keys, JSON fields as JSON text, undefined fields dropped.
 * Field names only ever come from the record builders in common.ts, never from callers; the check is a second guard.
 */
export function toRow(table: TableName, fields: object): Row {
  const jsonFields = JSON_FIELDS[table] ?? [];
  const row: Row = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const column = toSnake(key);
    if (!COLUMN_NAME.test(column)) throw new StorageError(`A ${table} record has an invalid field name: ${key}.`);
    row[column] = jsonFields.includes(key) ? toJsonText(value, `${table}.${key}`) : value;
  }
  return row;
}

/** Skills keep their counters in three columns. */
export function skillToRow(skill: SkillRecord): Row {
  const { counters, ...rest } = skill;
  return { ...toRow("skills", rest), views: counters.views, uses: counters.uses, patches: counters.patches };
}
