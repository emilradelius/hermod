/**
 * Shared helpers for the three storage adapters (in-memory, SQLite, Postgres): errors, ids and ISO times, input
 * validation, defaults for new records, JSON and text cleaning, and the plain-word search helpers (tokenizing,
 * diacritic folding, snippets).
 *
 * Every adapter builds and validates its records with these functions, so a new record gets the same defaults and
 * the same checks everywhere, and one conformance suite can hold all adapters to one behaviour.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  AgentRecord,
  AuditRecord,
  CallPurpose,
  CostRecord,
  DeliveryRecord,
  DraftScore,
  Id,
  IsoTime,
  JobRecord,
  MemoryStoreRecord,
  MessageRecord,
  NewAgent,
  NewJob,
  NewProposal,
  NewSession,
  ProposalKind,
  ProposalRecord,
  ProposalStatus,
  SessionCounters,
  SessionKind,
  SessionRecord,
  SessionStatus,
  SkillRecord,
  SkillStatus,
  SkillVersionRecord,
  Storage,
} from "../types.js";

// ─── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Thrown for invalid input or an impossible write (a duplicate id, an unknown session). */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Input shapes (derived from the Storage contract, so they never drift) ──────────────────────────────────

export type NewMessage = Parameters<Storage["messages"]["append"]>[1];
export type NewSkill = Parameters<Storage["skills"]["create"]>[0];
export type SkillChange = Parameters<Storage["skills"]["update"]>[1];
export type SkillVersionMeta = Parameters<Storage["skills"]["update"]>[2];
export type NewAudit = Parameters<Storage["audit"]["append"]>[0];
export type NewCost = Parameters<Storage["costs"]["add"]>[0];
export type NewDelivery = Parameters<Storage["deliveries"]["add"]>[0];
export type AgentPatch = Parameters<Storage["agents"]["update"]>[1];
export type SessionPatch = Parameters<Storage["sessions"]["update"]>[1];
export type MemoryPolicy = Parameters<Storage["memory"]["setPolicy"]>[1];
export type JobOutcome = Parameters<Storage["jobs"]["finish"]>[1];
export type SkillCounter = Parameters<Storage["skills"]["bump"]>[1];

// ─── Allowed values ─────────────────────────────────────────────────────────────────────────────────────────

/** Lists every member of a string union; the compiler fails here if the union in types.ts gains a member. */
function allOf<T extends string>(members: Record<T, true>): readonly T[] {
  return Object.keys(members) as T[];
}

export const AGENT_MODES = allOf<AgentMode>({ off: true, shadow: true, supervised: true, autonomous: true });
export const SESSION_KINDS = allOf<SessionKind>({ chat: true, job: true, review: true, delegate: true, eval: true });
export const SESSION_STATUSES = allOf<SessionStatus>({ running: true, done: true, error: true, aborted: true });
export const MESSAGE_ROLES = allOf<MessageRecord["role"]>({ user: true, assistant: true, system: true });
export const AUTO_APPLY = allOf<MemoryStoreRecord["autoApply"]>({ none: true, add: true });
export const SKILL_STATUSES = allOf<SkillStatus>({ active: true, stale: true, archived: true });
export const SKILL_COUNTERS = allOf<SkillCounter>({ views: true, uses: true, patches: true });
export const PROPOSAL_KINDS = allOf<ProposalKind>({ memory: true, skill: true, action: true });
export const PROPOSAL_STATUSES = allOf<ProposalStatus>({
  pending: true,
  approved: true,
  rejected: true,
  applied: true,
  expired: true,
});
export const DRAFT_SCORES = allOf<DraftScore>({ as_is: true, small_edit: true, wrong: true });
export const CALL_PURPOSES = allOf<CallPurpose>({
  main: true,
  review: true,
  summary: true,
  delegate: true,
  job: true,
  eval: true,
});
export const JOB_STATUSES = allOf<NonNullable<JobRecord["lastStatus"]>>({
  ok: true,
  silent: true,
  skipped: true,
  error: true,
});
export const DELIVERY_STATUSES = allOf<DeliveryRecord["status"]>({ queued: true, sent: true, failed: true });

// ─── Defaults ───────────────────────────────────────────────────────────────────────────────────────────────

/** A new agent starts in shadow mode: it drafts, a person scores the drafts, and only a person promotes it. */
export const AGENT_DEFAULTS = {
  mode: "shadow",
  accuracyBar: 0.9,
  minSamples: 20,
  monthlyCostCapUsd: null,
} as const satisfies Pick<AgentRecord, "mode" | "accuracyBar" | "minSamples" | "monthlyCostCapUsd">;

/** messages.search returns at most this many hits unless a limit is given. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** jobs.claimDue leases at most this many jobs unless a limit is given. */
export const DEFAULT_CLAIM_LIMIT = 10;

// ─── Options, ids and times ─────────────────────────────────────────────────────────────────────────────────

export interface StorageOptions {
  /** The clock for createdAt, updatedAt and startedAt. Default: the system clock. */
  now?: () => Date;
  /** The id generator for new records. Default: crypto.randomUUID(). */
  newId?: () => Id;
}

export interface Clock {
  /** The current time in toISOString() format. */
  nowIso(): IsoTime;
  newId(): Id;
}

export function makeClock(options: StorageOptions = {}): Clock {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  return {
    nowIso() {
      const date = now();
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new StorageError("The storage clock returned something that is not a valid Date.");
      }
      return date.toISOString();
    },
    newId: () => requireId(newId(), "A generated id"),
  };
}

/** The given id, or a new one when none was given. */
export function pickId(given: unknown, clock: Clock, field: string): Id {
  return given === undefined || given === null ? clock.newId() : requireId(given, field);
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/i;

/**
 * Accepts an ISO 8601 date ("2026-11-05", read as UTC midnight) or date-time with a zone ("…T10:00:00+02:00",
 * "…Z"), or a valid Date, and returns it in toISOString() format (UTC, milliseconds). Stored times always have this
 * one format, so they also sort correctly as text.
 */
export function requireIso(value: unknown, field: string): IsoTime {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return checkedIso(value, field, String(value));
  const match = typeof value === "string" ? ISO_TIME.exec(value) : null;
  if (!match) {
    throw new StorageError(
      `${field} must be an ISO 8601 time with a zone, like "2026-11-05T20:00:00.000Z"; got ${show(value)}.`,
    );
  }
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone = "Z"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], Number(fraction.padEnd(3, "0").slice(0, 3)));
  const same =
    date.getUTCFullYear() === parts[0] &&
    date.getUTCMonth() === parts[1] - 1 &&
    date.getUTCDate() === parts[2] &&
    date.getUTCHours() === parts[3] &&
    date.getUTCMinutes() === parts[4] &&
    date.getUTCSeconds() === parts[5];
  if (!same) throw new StorageError(`${field} is not a real date and time: ${show(value)}.`);
  return checkedIso(new Date(date.getTime() - zoneOffsetMs(zone, field)), field, String(value));
}

export function optionalIso(value: unknown, field: string): IsoTime | null {
  return value === null || value === undefined ? null : requireIso(value, field);
}

/** An ISO time plus a number of milliseconds. */
export function addMs(iso: IsoTime, ms: number, field: string): IsoTime {
  return checkedIso(new Date(Date.parse(iso) + ms), field, `${iso} + ${ms} ms`);
}

function zoneOffsetMs(zone: string, field: string): number {
  if (zone.toUpperCase() === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const [hours = 0, minutes = 0] = zone.slice(1).split(":").map(Number);
  if (hours > 23 || minutes > 59) throw new StorageError(`${field} has an impossible time zone offset: ${zone}.`);
  return sign * (hours * 60 + minutes) * 60_000;
}

function checkedIso(date: Date, field: string, original: string): IsoTime {
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 0 || year > 9999) {
    throw new StorageError(`${field} is outside the years 0000 to 9999: ${original}.`);
  }
  return date.toISOString();
}

// ─── Validation ─────────────────────────────────────────────────────────────────────────────────────────────

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}

// Ids are opaque, but they must be printable and of a sane length.
// eslint-disable-next-line no-control-regex -- control characters are exactly what this pattern rejects.
const ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;

export function requireId(value: unknown, field: string): Id {
  if (typeof value === "string" && ID_PATTERN.test(value)) return value;
  throw new StorageError(`${field} must be a non-empty id of at most 512 printable characters; got ${show(value)}.`);
}

export function optionalId(value: unknown, field: string): Id | null {
  return value === null || value === undefined ? null : requireId(value, field);
}

/** Any string (may be empty), cleaned with cleanText. */
export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new StorageError(`${field} must be a string; got ${show(value)}.`);
  return cleanText(value);
}

/** A non-empty string, cleaned with cleanText. */
export function requireName(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (text.length === 0) throw new StorageError(`${field} must not be empty.`);
  return text;
}

export function optionalText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : requireText(value, field);
}

export function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new StorageError(`${field} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}; got ${show(value)}.`);
}

export function requireInteger(value: unknown, field: string, min = 0): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min) return value;
  throw new StorageError(`${field} must be a whole number of at least ${min}; got ${show(value)}.`);
}

export function requireNumber(value: unknown, field: string, range: { min?: number; max?: number } = {}): number {
  const { min = -Infinity, max = Infinity } = range;
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
  const bounds = [Number.isFinite(min) ? `at least ${min}` : "", Number.isFinite(max) ? `at most ${max}` : ""]
    .filter(Boolean)
    .join(" and ");
  throw new StorageError(`${field} must be a finite number${bounds ? ` ${bounds}` : ""}; got ${show(value)}.`);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new StorageError(`${field} must be true or false; got ${show(value)}.`);
}

/** A list limit: undefined or null means `fallback` (null = no limit); otherwise a whole number ≥ 0. */
export function normalizeLimit(value: unknown, fallback: number | null): number | null {
  if (value === undefined || value === null) return fallback;
  return requireInteger(value, "limit");
}

/** Copies `limit` items at most (null = all). */
export function takeLimit<T>(items: T[], limit: number | null): T[] {
  return limit === null ? items : items.slice(0, limit);
}

// ─── Text and JSON cleaning ─────────────────────────────────────────────────────────────────────────────────

// U+0000 and unpaired UTF-16 surrogates cannot be stored by Postgres (text or jsonb). Every adapter replaces them
// with U+FFFD, so all three store exactly the same text.
// eslint-disable-next-line no-control-regex -- U+0000 is one of the characters this pattern replaces.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(text: string): string {
  return text.replace(UNSTORABLE, "�");
}

// JSON.stringify escapes U+0000 and lone surrogates (and only those) as \u0000 / \udXXX.
const JSON_NEEDS_CLEANING = /\\u(?:0000|d[89a-f][0-9a-f]{2})/i;

function cleanJsonValue(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(cleanJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key), cleanJsonValue(item)]));
  }
  return value;
}

/** JSON text for a value, with strings cleaned. Throws a StorageError for values JSON cannot represent. */
export function toJsonText(value: unknown, field: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
    if (text !== undefined && JSON_NEEDS_CLEANING.test(text)) text = JSON.stringify(cleanJsonValue(JSON.parse(text)));
  } catch (error) {
    throw new StorageError(`${field} must be JSON-serializable (${errorMessage(error)}).`, { cause: error });
  }
  if (text === undefined) throw new StorageError(`${field} must be JSON-serializable; got ${show(value)}.`);
  return text;
}

/** The value as it comes back from a JSON round trip (what every adapter stores). */
export function toJsonValue<T>(value: T, field: string): T {
  return JSON.parse(toJsonText(value, field)) as T;
}

export function requireJsonObject(value: unknown, field: string): Record<string, unknown> {
  const json: unknown = value === undefined ? value : toJsonValue(value, field);
  if (json !== null && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
  throw new StorageError(`${field} must be a plain object; got ${show(value)}.`);
}

function requireJsonArray<T>(value: T[], field: string): T[] {
  if (!Array.isArray(value)) throw new StorageError(`${field} must be an array; got ${show(value)}.`);
  return toJsonValue(value, field);
}

// ─── Records: agents ────────────────────────────────────────────────────────────────────────────────────────

export function agentPatch(patch: AgentPatch): AgentPatch {
  const out: AgentPatch = {};
  if (patch.mode !== undefined) out.mode = requireOneOf(patch.mode, AGENT_MODES, "Agent mode");
  if (patch.accuracyBar !== undefined) {
    out.accuracyBar = requireNumber(patch.accuracyBar, "Agent accuracyBar", { min: 0, max: 1 });
  }
  if (patch.minSamples !== undefined) out.minSamples = requireInteger(patch.minSamples, "Agent minSamples");
  if (patch.monthlyCostCapUsd !== undefined) {
    out.monthlyCostCapUsd =
      patch.monthlyCostCapUsd === null
        ? null
        : requireNumber(patch.monthlyCostCapUsd, "Agent monthlyCostCapUsd", { min: 0 });
  }
  return out;
}

export function buildAgent(input: NewAgent, at: IsoTime): AgentRecord {
  return {
    id: requireId(input.id, "Agent id"),
    name: requireName(input.name, "Agent name"),
    ...AGENT_DEFAULTS,
    ...agentPatch(input),
    createdAt: at,
    updatedAt: at,
  };
}

/** What an upsert of an existing agent changes: the name, the fields given, and updatedAt. */
export function agentUpsertChanges(input: NewAgent, at: IsoTime): Partial<AgentRecord> {
  return { name: requireName(input.name, "Agent name"), ...agentPatch(input), updatedAt: at };
}

// ─── Records: sessions and messages ─────────────────────────────────────────────────────────────────────────

function requireCounters(value: unknown): SessionCounters {
  const counters = requireJsonObject(value, "Session counters");
  return {
    userTurns: requireInteger(counters.userTurns, "Session counters.userTurns"),
    toolIterations: requireInteger(counters.toolIterations, "Session counters.toolIterations"),
    lastMemoryReviewTurn: requireInteger(counters.lastMemoryReviewTurn, "Session counters.lastMemoryReviewTurn"),
    lastSkillReviewIteration: requireInteger(
      counters.lastSkillReviewIteration,
      "Session counters.lastSkillReviewIteration",
    ),
  };
}

export function buildSession(input: NewSession, id: Id, at: IsoTime): SessionRecord {
  return {
    id,
    agentId: requireId(input.agentId, "Session agentId"),
    kind: requireOneOf(input.kind, SESSION_KINDS, "Session kind"),
    parentId: optionalId(input.parentId, "Session parentId"),
    attended: requireBoolean(input.attended, "Session attended"),
    startedAt: input.startedAt === undefined ? at : requireIso(input.startedAt, "Session startedAt"),
    endedAt: null,
    status: "running",
    memorySnapshot: requireText(input.memorySnapshot, "Session memorySnapshot"),
    skillsIndex: requireText(input.skillsIndex, "Session skillsIndex"),
    counters: { userTurns: 0, toolIterations: 0, lastMemoryReviewTurn: 0, lastSkillReviewIteration: 0 },
    meta: input.meta === undefined ? {} : requireJsonObject(input.meta, "Session meta"),
  };
}

/** Only endedAt, status, counters (all four) and meta (replaced whole) can change; anything else is ignored. */
export function sessionPatch(patch: SessionPatch): SessionPatch {
  const out: SessionPatch = {};
  if (patch.endedAt !== undefined) out.endedAt = optionalIso(patch.endedAt, "Session endedAt");
  if (patch.status !== undefined) out.status = requireOneOf(patch.status, SESSION_STATUSES, "Session status");
  if (patch.counters !== undefined) out.counters = requireCounters(patch.counters);
  if (patch.meta !== undefined) out.meta = requireJsonObject(patch.meta, "Session meta");
  return out;
}

export function buildMessage(sessionId: Id, input: NewMessage, id: Id, seq: number, at: IsoTime): MessageRecord {
  const content: unknown = input.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new StorageError(`Message content must be a string or an array of content blocks; got ${show(content)}.`);
  }
  return {
    id,
    sessionId,
    seq,
    role: requireOneOf(input.role, MESSAGE_ROLES, "Message role"),
    content: toJsonValue(input.content, "Message content"),
    text: requireText(input.text, "Message text"),
    createdAt: at,
  };
}

// ─── Records: memory stores ─────────────────────────────────────────────────────────────────────────────────

export function memoryPolicy(policy: MemoryPolicy): MemoryPolicy {
  const out: MemoryPolicy = {};
  if (policy.capChars !== undefined) out.capChars = requireInteger(policy.capChars, "Memory store capChars");
  if (policy.autoApply !== undefined) {
    out.autoApply = requireOneOf(policy.autoApply, AUTO_APPLY, "Memory store autoApply");
  }
  return out;
}

export type MemoryStoreDefaults = Pick<MemoryStoreRecord, "capChars" | "autoApply">;

export function memoryStoreDefaults(defaults: MemoryStoreDefaults): MemoryStoreDefaults {
  return {
    capChars: requireInteger(defaults?.capChars, "Memory store capChars"),
    autoApply: requireOneOf(defaults?.autoApply, AUTO_APPLY, "Memory store autoApply"),
  };
}

/** A new store is empty at version 0; the first writeContent expects version 0. */
export function buildMemoryStore(
  agentId: Id,
  name: string,
  defaults: MemoryStoreDefaults,
  id: Id,
  at: IsoTime,
): MemoryStoreRecord {
  return {
    id,
    agentId: requireId(agentId, "Memory store agentId"),
    name: requireName(name, "Memory store name"),
    ...memoryStoreDefaults(defaults),
    content: "",
    version: 0,
    updatedAt: at,
  };
}

// ─── Records: skills ────────────────────────────────────────────────────────────────────────────────────────

export function skillChange(change: SkillChange): SkillChange {
  return {
    description: requireText(change?.description, "Skill description"),
    body: requireText(change?.body, "Skill body"),
  };
}

export function skillVersionMeta(meta: SkillVersionMeta): SkillVersionMeta {
  return {
    createdBy: requireName(meta?.createdBy, "Skill version createdBy"),
    proposalId: optionalId(meta?.proposalId, "Skill version proposalId"),
  };
}

/** A new skill is version 1 and active; its first version row is written with it. */
export function buildSkill(input: NewSkill, id: Id, at: IsoTime): { skill: SkillRecord; version: SkillVersionRecord } {
  const { description, body } = skillChange(input);
  const skill: SkillRecord = {
    id,
    agentId: requireId(input.agentId, "Skill agentId"),
    name: requireName(input.name, "Skill name"),
    description,
    body,
    version: 1,
    status: "active",
    pinned: input.pinned === undefined ? false : requireBoolean(input.pinned, "Skill pinned"),
    createdAt: at,
    updatedAt: at,
    lastUsedAt: null,
    counters: { views: 0, uses: 0, patches: 0 },
  };
  const meta = skillVersionMeta({ createdBy: input.createdBy, proposalId: null });
  return { skill, version: { skillId: id, version: 1, description, body, createdAt: at, ...meta } };
}

// ─── Records: proposals ─────────────────────────────────────────────────────────────────────────────────────

export function buildProposal(input: NewProposal, id: Id, at: IsoTime): ProposalRecord {
  const kind = requireOneOf(input.kind, PROPOSAL_KINDS, "Proposal kind");
  const payload = requireJsonObject(input.payload, "Proposal payload");
  if (payload.kind !== kind) {
    throw new StorageError(`Proposal payload.kind must match the proposal kind "${kind}"; got ${show(payload.kind)}.`);
  }
  return {
    id,
    agentId: requireId(input.agentId, "Proposal agentId"),
    sessionId: optionalId(input.sessionId, "Proposal sessionId"),
    kind,
    target: requireName(input.target, "Proposal target"),
    payload: payload as unknown as ProposalRecord["payload"],
    evidence: requireJsonArray(input.evidence, "Proposal evidence"),
    rationale: requireText(input.rationale, "Proposal rationale"),
    status: "pending",
    createdBy: requireName(input.createdBy, "Proposal createdBy"),
    createdAt: at,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    score: null,
    shadow: input.shadow === undefined ? false : requireBoolean(input.shadow, "Proposal shadow"),
  };
}

export interface Transition {
  from: ProposalStatus[];
  to: ProposalStatus;
  at: IsoTime;
  by: string;
  /** undefined keeps the current note; null clears it. */
  note: string | null | undefined;
}

export function transitionArgs(
  from: ProposalStatus[],
  to: ProposalStatus,
  decision: { at: IsoTime; by: string; note?: string | null },
): Transition {
  if (!Array.isArray(from)) throw new StorageError(`Proposal transition "from" must be an array of statuses.`);
  return {
    from: [...new Set(from.map((status) => requireOneOf(status, PROPOSAL_STATUSES, "Proposal transition from")))],
    to: requireOneOf(to, PROPOSAL_STATUSES, "Proposal transition to"),
    at: requireIso(decision?.at, "Proposal decision at"),
    by: requireName(decision?.by, "Proposal decision by"),
    note: decision?.note === undefined ? undefined : optionalText(decision.note, "Proposal decision note"),
  };
}

// ─── Records: audit, costs ──────────────────────────────────────────────────────────────────────────────────

export function buildAudit(input: NewAudit, id: Id): AuditRecord {
  return {
    id,
    at: requireIso(input.at, "Audit at"),
    actor: requireName(input.actor, "Audit actor"),
    action: requireName(input.action, "Audit action"),
    target: requireText(input.target, "Audit target"),
    details: input.details === undefined ? {} : requireJsonObject(input.details, "Audit details"),
  };
}

export function buildCost(input: NewCost, id: Id): CostRecord {
  return {
    id,
    at: requireIso(input.at, "Cost at"),
    agentId: requireId(input.agentId, "Cost agentId"),
    sessionId: optionalId(input.sessionId, "Cost sessionId"),
    model: requireName(input.model, "Cost model"),
    purpose: requireOneOf(input.purpose, CALL_PURPOSES, "Cost purpose"),
    inputTokens: requireInteger(input.inputTokens, "Cost inputTokens"),
    outputTokens: requireInteger(input.outputTokens, "Cost outputTokens"),
    cacheReadTokens: requireInteger(input.cacheReadTokens, "Cost cacheReadTokens"),
    cacheWriteTokens: requireInteger(input.cacheWriteTokens, "Cost cacheWriteTokens"),
    costUsd: requireNumber(input.costUsd, "Cost costUsd", { min: 0 }),
  };
}

// ─── Records: jobs and deliveries ───────────────────────────────────────────────────────────────────────────

type RequiredJobFields = Pick<JobRecord, "agentId" | "name" | "schedule" | "timeZone" | "prompt" | "deliver">;
export type JobFields = RequiredJobFields & Partial<Pick<JobRecord, "skills" | "preStep" | "enabled" | "nextRunAt">>;

/** The fields an upsert writes: all required ones, plus the optional ones that were given. */
export function jobFields(input: NewJob): JobFields {
  const out: JobFields = {
    agentId: requireId(input.agentId, "Job agentId"),
    name: requireName(input.name, "Job name"),
    schedule: requireName(input.schedule, "Job schedule"),
    timeZone: requireName(input.timeZone, "Job timeZone"),
    prompt: requireText(input.prompt, "Job prompt"),
    deliver: requireName(input.deliver, "Job deliver"),
  };
  if (input.skills !== undefined) {
    out.skills = requireJsonArray(input.skills, "Job skills").map((skill) => requireName(skill, "Job skill name"));
  }
  if (input.preStep !== undefined) out.preStep = input.preStep === null ? null : requireName(input.preStep, "Job preStep");
  if (input.enabled !== undefined) out.enabled = requireBoolean(input.enabled, "Job enabled");
  if (input.nextRunAt !== undefined) out.nextRunAt = optionalIso(input.nextRunAt, "Job nextRunAt");
  return out;
}

/** A new job is enabled, has never run and is not leased. nextRunAt stays null until the scheduler sets it. */
export function buildJob(input: NewJob, id: Id): JobRecord {
  const { skills = [], preStep = null, enabled = true, nextRunAt = null, ...required } = jobFields(input);
  return {
    id,
    ...required,
    skills,
    preStep,
    enabled,
    nextRunAt,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    failures: 0,
    lockedUntil: null,
    lockedBy: null,
  };
}

export function jobOutcome(outcome: JobOutcome): JobOutcome {
  return {
    lastRunAt: optionalIso(outcome?.lastRunAt, "Job lastRunAt"),
    lastStatus:
      outcome?.lastStatus === null || outcome?.lastStatus === undefined
        ? null
        : requireOneOf(outcome.lastStatus, JOB_STATUSES, "Job lastStatus"),
    lastError: optionalText(outcome?.lastError, "Job lastError"),
    nextRunAt: optionalIso(outcome?.nextRunAt, "Job nextRunAt"),
    failures: requireInteger(outcome?.failures, "Job failures"),
  };
}

export interface ClaimArgs {
  now: IsoTime;
  lockedUntil: IsoTime;
  worker: string;
  limit: number;
}

export function claimArgs(now: IsoTime, options: { leaseMs: number; worker: string; limit?: number }): ClaimArgs {
  const at = requireIso(now, "claimDue now");
  const leaseMs = requireNumber(options?.leaseMs, "claimDue leaseMs", { min: 1 });
  return {
    now: at,
    lockedUntil: addMs(at, Math.ceil(leaseMs), "The lease end"),
    worker: requireName(options?.worker, "claimDue worker"),
    limit: normalizeLimit(options?.limit, DEFAULT_CLAIM_LIMIT) ?? DEFAULT_CLAIM_LIMIT,
  };
}

export function buildDelivery(input: NewDelivery, id: Id, at: IsoTime): DeliveryRecord {
  return {
    id,
    channel: requireName(input.channel, "Delivery channel"),
    target: requireName(input.target, "Delivery target"),
    title: requireText(input.title, "Delivery title"),
    body: requireText(input.body, "Delivery body"),
    url: optionalText(input.url, "Delivery url"),
    createdAt: at,
    status: "queued",
    error: null,
    jobId: optionalId(input.jobId, "Delivery jobId"),
  };
}

// ─── Sorting (in-memory adapter; the SQL adapters use the same orders in ORDER BY) ──────────────────────────

/** Code point order, the same as SQLite's BINARY collation and Postgres's COLLATE "C". */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Newest first by `key`; records with the same time keep newest-inserted first. `items` is in insertion order. */
export function newestFirst<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].reverse().sort((a, b) => compareText(key(b), key(a)));
}

// ─── Search: tokens, folding, snippets ──────────────────────────────────────────────────────────────────────

/** A word: a letter or digit, then letters, digits and combining marks (the same split as FTS5's unicode61). */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
/** Diacritics on Latin letters only, like FTS5's `remove_diacritics 2` (Greek accents etc. stay). */
const LATIN_DIACRITICS = /(\p{Script=Latin})\p{M}+/gu;

/** At most this many distinct words of a query are searched. */
export const MAX_QUERY_TERMS = 32;
const MAX_QUERY_CHARS = 2_000;
/** Longer "words" (hashes, base64 blobs) are not indexed or searched. */
export const MAX_TERM_CHARS = 200;
/** The Postgres adapter indexes this much folded text per message (tsvector has a 1 MB limit). */
export const MAX_SEARCH_TEXT_CHARS = 100_000;

/** Lowercase, with diacritics removed from Latin letters: "Rätta" → "ratta", "ÖVER" → "over". */
export function foldWord(word: string): string {
  return word.toLowerCase().normalize("NFD").replace(LATIN_DIACRITICS, "$1").normalize("NFC");
}

/** The folded words of a text, in order. */
export function foldedWords(text: string): string[] {
  const words: string[] = [];
  for (const match of text.matchAll(WORD)) {
    if (match[0].length <= MAX_TERM_CHARS) words.push(foldWord(match[0]));
  }
  return words;
}

/**
 * The plain words of a search query: folded, distinct, at most MAX_QUERY_TERMS. Everything that is not a letter,
 * digit or mark is a separator, so no query syntax (quotes, operators, parentheses, `*`, `:`) survives. A query
 * with no words gives [] and the adapters return no hits without touching the database.
 */
export function searchTerms(query: unknown): string[] {
  if (typeof query !== "string") return [];
  return [...new Set(foldedWords(query.slice(0, MAX_QUERY_CHARS)))].slice(0, MAX_QUERY_TERMS);
}

/** The folded words of a text joined by spaces, capped at MAX_SEARCH_TEXT_CHARS (what Postgres indexes). */
export function buildSearchText(text: string): string {
  let out = "";
  for (const word of foldedWords(text)) {
    if (out.length + word.length + 1 > MAX_SEARCH_TEXT_CHARS) break;
    out = out ? `${out} ${word}` : word;
  }
  return out;
}

/** How often each folded word occurs (the in-memory adapter's index). */
export function wordCounts(words: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

/** In-memory relevance: one point per matched term plus a little for repeats. 0 = no match. */
export function matchScore(counts: ReadonlyMap<string, number>, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) {
    const n = counts.get(term) ?? 0;
    if (n > 0) score += 1 + Math.min(n, 9) / 10;
  }
  return score;
}

/** How snippets mark matched words and cut text, in every adapter. */
export const SNIPPET_MARKS = { start: "**", end: "**", ellipsis: "…" } as const;
/** Words in a snippet (also FTS5 snippet()'s token count). */
export const SNIPPET_WORDS = 20;
const SNIPPET_WORDS_BEFORE = 6;
const SNIPPET_MAX_WORD = 40;
const SNIPPET_MAX_GAP = 8;

interface WordSpan {
  start: number;
  end: number;
  folded: string;
}

interface SnippetWindow {
  spans: WordSpan[];
  before: boolean;
  after: boolean;
}

function spanOf(match: RegExpExecArray): WordSpan {
  return { start: match.index, end: match.index + match[0].length, folded: foldWord(match[0]) };
}

/** The first SNIPPET_WORDS words starting a few words before the first matching word (or the text's start). */
function snippetWindow(text: string, wanted: ReadonlySet<string>): SnippetWindow {
  const lead: WordSpan[] = [];
  const spans: WordSpan[] = [];
  let before = false;
  for (const match of text.matchAll(WORD)) {
    const span = spanOf(match);
    if (spans.length > 0) {
      if (spans.length === SNIPPET_WORDS) return { spans, before, after: true };
      spans.push(span);
    } else if (wanted.has(span.folded)) {
      spans.push(...lead, span);
    } else {
      lead.push(span);
      if (lead.length > SNIPPET_WORDS_BEFORE) {
        lead.shift();
        before = true;
      }
    }
  }
  return spans.length > 0 ? { spans, before, after: false } : firstWords(text);
}

/** The text's first SNIPPET_WORDS words (used when no word matches, e.g. a match only the database saw). */
function firstWords(text: string): SnippetWindow {
  const spans: WordSpan[] = [];
  for (const match of text.matchAll(WORD)) {
    if (spans.length === SNIPPET_WORDS) return { spans, before: false, after: true };
    spans.push(spanOf(match));
  }
  return { spans, before: false, after: false };
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}${SNIPPET_MARKS.ellipsis}` : text;
}

/**
 * A short excerpt around the first word of `text` that matches one of the folded `terms`, with matched words
 * marked (`**word**`) and an ellipsis where text was cut. Matching folds case and Latin diacritics, so the term
 * "ratta" marks "Rätta" while the excerpt keeps the original spelling.
 */
export function buildSnippet(text: string, terms: Iterable<string>): string {
  const wanted = new Set(terms);
  const { spans, before, after } = snippetWindow(text, wanted);
  if (spans.length === 0) return clip(text.replace(/\s+/g, " ").trim(), 2 * SNIPPET_WORDS);
  let out = "";
  let previousEnd: number | null = null;
  for (const span of spans) {
    if (previousEnd !== null) out += clip(text.slice(previousEnd, span.start).replace(/\s+/g, " "), SNIPPET_MAX_GAP);
    const word = clip(text.slice(span.start, span.end), SNIPPET_MAX_WORD);
    out += wanted.has(span.folded) ? `${SNIPPET_MARKS.start}${word}${SNIPPET_MARKS.end}` : word;
    previousEnd = span.end;
  }
  return `${before ? SNIPPET_MARKS.ellipsis : ""}${out}${after ? SNIPPET_MARKS.ellipsis : ""}`;
}

// ─── Misc ───────────────────────────────────────────────────────────────────────────────────────────────────

/** camelCase → snake_case for column names (only ever applied to field names from this module). */
export function toSnake(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
