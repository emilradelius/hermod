/**
 * In-memory Storage for tests, evals and prototypes: plain Maps, nothing persisted.
 *
 * Every record is copied on the way in (through the JSON-safe builders in common.ts) and on the way out
 * (structuredClone), so a caller can never change stored state by mutating an object it passed in or got back.
 * Each method runs synchronously inside its promise, so concurrent calls cannot interleave: appends never reuse a
 * seq, compare-and-set writes have exactly one winner and two claimers never lease the same job.
 */
import type {
  AgentRecord,
  AuditRecord,
  CostRecord,
  DeliveryRecord,
  Id,
  JobRecord,
  MemoryStoreRecord,
  MessageRecord,
  ProposalRecord,
  SearchHit,
  SessionRecord,
  SkillRecord,
  SkillVersionRecord,
  Storage,
} from "../types.js";
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
  buildSnippet,
  claimArgs,
  compareText,
  DEFAULT_SEARCH_LIMIT,
  DELIVERY_STATUSES,
  DRAFT_SCORES,
  expectedSkillVersion,
  finishWorker,
  foldedWords,
  jobFields,
  jobOutcome,
  makeClock,
  matchScore,
  memoryPolicy,
  memoryStoreDefaults,
  newestFirst,
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
  requireName,
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
  takeLimit,
  transitionArgs,
  type Clock,
  type StorageOptions,
  wordCounts,
} from "./common.js";

export type MemoryStorageOptions = StorageOptions;

interface State {
  agents: Map<Id, AgentRecord>;
  sessions: Map<Id, SessionRecord>;
  messages: Map<Id, MessageRecord>;
  /** Message ids per session, in seq order. */
  sessionMessages: Map<Id, Id[]>;
  /** Folded word counts per message id (messages never change, so this is computed once). */
  words: Map<Id, Map<string, number>>;
  stores: Map<Id, MemoryStoreRecord>;
  skills: Map<Id, SkillRecord>;
  skillVersions: Map<Id, SkillVersionRecord[]>;
  proposals: Map<Id, ProposalRecord>;
  audit: Map<Id, AuditRecord>;
  costs: Map<Id, CostRecord>;
  jobs: Map<Id, JobRecord>;
  deliveries: Map<Id, DeliveryRecord>;
}

const copy = <T>(value: T): T => structuredClone(value);
const copyOrNull = <T>(value: T | undefined): T | null => (value === undefined ? null : copy(value));

function insertNew<T extends { id: Id }>(map: Map<Id, T>, record: T, what: string): T {
  if (map.has(record.id)) throw new StorageError(`A ${what} with id "${record.id}" already exists.`);
  map.set(record.id, record);
  return copy(record);
}

/** Replaces a stored record with a changed copy and returns a copy of the result (null when there is none). */
function change<T>(map: Map<Id, T>, id: Id, edit: (current: T) => T): T | null {
  const current = map.get(id);
  if (current === undefined) return null;
  const next = edit(current);
  map.set(id, next);
  return copy(next);
}

export function createMemoryStorage(options: MemoryStorageOptions = {}): Storage {
  const clock = makeClock(options);
  const state: State = {
    agents: new Map(),
    sessions: new Map(),
    messages: new Map(),
    sessionMessages: new Map(),
    words: new Map(),
    stores: new Map(),
    skills: new Map(),
    skillVersions: new Map(),
    proposals: new Map(),
    audit: new Map(),
    costs: new Map(),
    jobs: new Map(),
    deliveries: new Map(),
  };
  return {
    async migrate() {},
    async close() {},
    agents: agentsRepo(state, clock),
    sessions: sessionsRepo(state, clock),
    messages: messagesRepo(state, clock),
    memory: memoryRepo(state, clock),
    skills: skillsRepo(state, clock),
    proposals: proposalsRepo(state, clock),
    audit: auditRepo(state, clock),
    costs: costsRepo(state, clock),
    jobs: jobsRepo(state, clock),
    deliveries: deliveriesRepo(state, clock),
  };
}

function agentsRepo(state: State, clock: Clock): Storage["agents"] {
  return {
    async upsert(input) {
      const id = requireId(input?.id, "Agent id");
      const existing = state.agents.get(id);
      const record = existing
        ? { ...existing, ...agentUpsertChanges(input, clock.nowIso()) }
        : buildAgent(input, clock.nowIso());
      state.agents.set(id, record);
      return copy(record);
    },
    async get(id) {
      return copyOrNull(state.agents.get(id));
    },
    async list() {
      const agents = [...state.agents.values()];
      return agents.sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id)).map(copy);
    },
    async update(id, patch) {
      const changes = agentPatch(patch ?? {});
      if (Object.keys(changes).length === 0) return copyOrNull(state.agents.get(id));
      return change(state.agents, id, (agent) => ({ ...agent, ...changes, updatedAt: clock.nowIso() }));
    },
  };
}

function sessionsRepo(state: State, clock: Clock): Storage["sessions"] {
  return {
    async create(input) {
      const record = buildSession(input, pickId(input?.id, clock, "Session id"), clock.nowIso());
      return insertNew(state.sessions, record, "session");
    },
    async get(id) {
      return copyOrNull(state.sessions.get(id));
    },
    async update(id, patch) {
      const changes = sessionPatch(patch ?? {});
      return change(state.sessions, id, (session) => ({ ...session, ...changes }));
    },
    async listByAgent(agentId, options) {
      const kind = options?.kind === undefined ? null : requireOneOf(options.kind, SESSION_KINDS, "Session kind");
      const limit = normalizeLimit(options?.limit, null);
      const sessions = [...state.sessions.values()].filter(
        (session) => session.agentId === agentId && (kind === null || session.kind === kind),
      );
      return takeLimit(newestFirst(sessions, (session) => session.startedAt), limit).map(copy);
    },
  };
}

function messagesRepo(state: State, clock: Clock): Storage["messages"] {
  return {
    async append(sessionId, input) {
      const session = state.sessions.get(requireId(sessionId, "Message sessionId"));
      if (!session) throw new StorageError(`Cannot append a message: there is no session with id "${sessionId}".`);
      const ids = state.sessionMessages.get(sessionId) ?? [];
      const record = buildMessage(sessionId, input, clock.newId(), ids.length, clock.nowIso());
      const stored = insertNew(state.messages, record, "message");
      state.sessionMessages.set(sessionId, [...ids, record.id]);
      state.words.set(record.id, wordCounts(foldedWords(record.text)));
      return stored;
    },
    async list(sessionId) {
      const ids = state.sessionMessages.get(sessionId) ?? [];
      return ids.flatMap((id) => {
        const message = state.messages.get(id);
        return message ? [copy(message)] : [];
      });
    },
    async get(id) {
      return copyOrNull(state.messages.get(id));
    },
    async search(query, options) {
      const terms = searchTerms(query);
      const agentId = optionalId(options?.agentId, "Search agentId");
      const excludeSessionId = optionalId(options?.excludeSessionId, "Search excludeSessionId");
      const limit = normalizeLimit(options?.limit, DEFAULT_SEARCH_LIMIT);
      if (terms.length === 0 || limit === 0) return [];
      const hits: Array<{ message: MessageRecord; score: number }> = [];
      for (const message of state.messages.values()) {
        if (message.sessionId === excludeSessionId) continue;
        const session = state.sessions.get(message.sessionId);
        if (!session || (agentId !== null && session.agentId !== agentId)) continue;
        const score = matchScore(state.words.get(message.id) ?? new Map(), terms);
        if (score > 0) hits.push({ message, score });
      }
      const ranked = newestFirst(hits, (hit) => hit.message.createdAt).sort((a, b) => b.score - a.score);
      return takeLimit(ranked, limit).map(({ message, score }) => searchHit(message, score, terms));
    },
  };
}

function searchHit(message: MessageRecord, score: number, terms: string[]): SearchHit {
  return {
    sessionId: message.sessionId,
    messageId: message.id,
    seq: message.seq,
    role: message.role,
    snippet: buildSnippet(message.text, terms),
    score,
    createdAt: message.createdAt,
  };
}

function memoryRepo(state: State, clock: Clock): Storage["memory"] {
  const find = (agentId: Id, name: string) =>
    [...state.stores.values()].find((store) => store.agentId === agentId && store.name === name);
  return {
    async ensureStore(agentId, name, defaults) {
      const validDefaults = memoryStoreDefaults(defaults);
      const existing = find(requireId(agentId, "Memory store agentId"), requireName(name, "Memory store name"));
      if (existing) return copy(existing);
      const record = buildMemoryStore(agentId, name, validDefaults, clock.newId(), clock.nowIso());
      return insertNew(state.stores, record, "memory store");
    },
    async getStore(agentId, name) {
      return copyOrNull(find(agentId, name));
    },
    async listStores(agentId) {
      const stores = [...state.stores.values()].filter((store) => store.agentId === agentId);
      return stores.sort((a, b) => compareText(a.name, b.name)).map(copy);
    },
    async writeContent(id, content, expectedVersion) {
      const text = requireText(content, "Memory store content");
      const expected = requireInteger(expectedVersion, "expectedVersion");
      const current = state.stores.get(id);
      if (!current || current.version !== expected) return null;
      return change(state.stores, id, (store) => ({
        ...store,
        content: text,
        version: store.version + 1,
        updatedAt: clock.nowIso(),
      }));
    },
    async setPolicy(id, policy) {
      const changes = memoryPolicy(policy ?? {});
      if (Object.keys(changes).length === 0) return copyOrNull(state.stores.get(id));
      return change(state.stores, id, (store) => ({ ...store, ...changes, updatedAt: clock.nowIso() }));
    },
  };
}

function skillsRepo(state: State, clock: Clock): Storage["skills"] {
  return {
    async create(input) {
      const { skill, version } = buildSkill(input, clock.newId(), clock.nowIso());
      const taken = [...state.skills.values()].some((s) => s.agentId === skill.agentId && s.name === skill.name);
      if (taken) {
        throw new StorageError(`A skill named "${skill.name}" already exists for agent "${skill.agentId}".`);
      }
      const stored = insertNew(state.skills, skill, "skill");
      state.skillVersions.set(skill.id, [version]);
      return stored;
    },
    async get(agentId, name) {
      return copyOrNull([...state.skills.values()].find((s) => s.agentId === agentId && s.name === name));
    },
    async list(agentId, options) {
      const status =
        options?.status === undefined ? null : requireOneOf(options.status, SKILL_STATUSES, "Skill status");
      const skills = [...state.skills.values()].filter(
        (skill) => skill.agentId === agentId && (status === null || skill.status === status),
      );
      return skills.sort((a, b) => compareText(a.name, b.name)).map(copy);
    },
    async update(id, changeInput, metaInput, expectedVersion) {
      const content = skillChange(changeInput);
      const meta = skillVersionMeta(metaInput);
      const expected = expectedSkillVersion(expectedVersion);
      const at = clock.nowIso();
      if (state.skills.get(id)?.version !== expected) return null;
      const updated = change(state.skills, id, (skill) => ({
        ...skill,
        ...content,
        version: skill.version + 1,
        updatedAt: at,
      }));
      if (updated) {
        const row: SkillVersionRecord = { skillId: id, version: updated.version, ...content, createdAt: at, ...meta };
        state.skillVersions.set(id, [...(state.skillVersions.get(id) ?? []), row]);
      }
      return updated;
    },
    async setStatus(id, status) {
      const next = requireOneOf(status, SKILL_STATUSES, "Skill status");
      return change(state.skills, id, (skill) => ({ ...skill, status: next }));
    },
    async setPinned(id, pinned) {
      const next = requireBoolean(pinned, "Skill pinned");
      return change(state.skills, id, (skill) => ({ ...skill, pinned: next }));
    },
    async bump(id, counter, at) {
      const field = requireOneOf(counter, SKILL_COUNTERS, "Skill counter");
      const when = requireIso(at, "Skill bump at");
      change(state.skills, id, (skill) => ({
        ...skill,
        counters: { ...skill.counters, [field]: skill.counters[field] + 1 },
        lastUsedAt: skill.lastUsedAt !== null && skill.lastUsedAt > when ? skill.lastUsedAt : when,
      }));
    },
    async versions(id) {
      return (state.skillVersions.get(id) ?? []).map(copy);
    },
  };
}

function proposalsRepo(state: State, clock: Clock): Storage["proposals"] {
  return {
    async create(input) {
      const record = buildProposal(input, pickId(input?.id, clock, "Proposal id"), clock.nowIso());
      return insertNew(state.proposals, record, "proposal");
    },
    async get(id) {
      return copyOrNull(state.proposals.get(id));
    },
    async list(options) {
      const agentId = optionalId(options?.agentId, "Proposal agentId");
      const sessionId = optionalId(options?.sessionId, "Proposal sessionId");
      const status =
        options?.status === undefined ? null : requireOneOf(options.status, PROPOSAL_STATUSES, "Proposal status");
      const kind = options?.kind === undefined ? null : requireOneOf(options.kind, PROPOSAL_KINDS, "Proposal kind");
      const limit = normalizeLimit(options?.limit, null);
      const proposals = [...state.proposals.values()].filter(
        (p) =>
          (agentId === null || p.agentId === agentId) &&
          (sessionId === null || p.sessionId === sessionId) &&
          (status === null || p.status === status) &&
          (kind === null || p.kind === kind),
      );
      return takeLimit(newestFirst(proposals, (p) => p.createdAt), limit).map(copy);
    },
    async transition(id, from, to, decision) {
      const args = transitionArgs(from, to, decision);
      const current = state.proposals.get(id);
      if (!current || !args.from.includes(current.status)) return null;
      return change(state.proposals, id, (proposal) => ({
        ...proposal,
        status: args.to,
        decidedAt: args.at,
        decidedBy: args.by,
        decisionNote: args.note === undefined ? proposal.decisionNote : args.note,
      }));
    },
    async setScore(id, score) {
      const next = requireOneOf(score, DRAFT_SCORES, "Proposal score");
      return change(state.proposals, id, (proposal) => ({ ...proposal, score: next }));
    },
  };
}

function auditRepo(state: State, clock: Clock): Storage["audit"] {
  // Append-only on purpose: there is no update or delete.
  return {
    async append(entry) {
      return insertNew(state.audit, buildAudit(entry, pickId(entry?.id, clock, "Audit id")), "audit entry");
    },
    async list(options) {
      const target = optionalText(options?.target, "Audit target filter");
      const actor = optionalText(options?.actor, "Audit actor filter");
      const action = optionalText(options?.action, "Audit action filter");
      const limit = normalizeLimit(options?.limit, null);
      const entries = [...state.audit.values()].filter(
        (e) =>
          (target === null || e.target === target) &&
          (actor === null || e.actor === actor) &&
          (action === null || e.action === action),
      );
      return takeLimit(newestFirst(entries, (e) => e.at), limit).map(copy);
    },
  };
}

function costsRepo(state: State, clock: Clock): Storage["costs"] {
  return {
    async add(input) {
      return insertNew(state.costs, buildCost(input, pickId(input?.id, clock, "Cost id")), "cost record");
    },
    async sum(options) {
      const agentId = requireId(options?.agentId, "Cost sum agentId");
      const since = requireIso(options?.since, "Cost sum since");
      let total = 0;
      for (const cost of state.costs.values()) {
        if (cost.agentId === agentId && cost.at >= since) total += cost.costUsd;
      }
      return total;
    },
    async list(options) {
      const agentId = optionalId(options?.agentId, "Cost agentId");
      const sessionId = optionalId(options?.sessionId, "Cost sessionId");
      const limit = normalizeLimit(options?.limit, null);
      const costs = [...state.costs.values()].filter(
        (c) => (agentId === null || c.agentId === agentId) && (sessionId === null || c.sessionId === sessionId),
      );
      return takeLimit(newestFirst(costs, (c) => c.at), limit).map(copy);
    },
  };
}

function jobsRepo(state: State, clock: Clock): Storage["jobs"] {
  const byName = (agentId: Id, name: string) =>
    [...state.jobs.values()].find((job) => job.agentId === agentId && job.name === name);
  return {
    async upsert(input) {
      const fields = jobFields(input);
      const givenId = input.id === undefined ? null : requireId(input.id, "Job id");
      const existing = givenId === null ? byName(fields.agentId, fields.name) : state.jobs.get(givenId);
      const id = existing?.id ?? givenId ?? clock.newId();
      const clash = byName(fields.agentId, fields.name);
      if (clash && clash.id !== id) {
        throw new StorageError(`A job named "${fields.name}" already exists for agent "${fields.agentId}".`);
      }
      const record = existing ? { ...existing, ...fields } : buildJob(input, id);
      state.jobs.set(id, record);
      return copy(record);
    },
    async get(id) {
      return copyOrNull(state.jobs.get(id));
    },
    async list(options) {
      const agentId = optionalId(options?.agentId, "Job agentId");
      const jobs = [...state.jobs.values()].filter((job) => agentId === null || job.agentId === agentId);
      return jobs.sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id)).map(copy);
    },
    async claimDue(now, options) {
      const args = claimArgs(now, options);
      const due = [...state.jobs.values()]
        .filter(
          (job) =>
            job.enabled &&
            job.nextRunAt !== null &&
            job.nextRunAt <= args.now &&
            (job.lockedUntil === null || job.lockedUntil <= args.now),
        )
        .sort((a, b) => compareText(a.nextRunAt ?? "", b.nextRunAt ?? "") || compareText(a.id, b.id))
        .slice(0, args.limit);
      return due.flatMap((job) => {
        const leased = change(state.jobs, job.id, (j) => ({ ...j, lockedUntil: args.lockedUntil, lockedBy: args.worker }));
        return leased ? [leased] : [];
      });
    },
    async finish(id, outcome, worker) {
      const result = jobOutcome(outcome);
      const owner = finishWorker(worker);
      // Only the worker that holds the lease may save the outcome and release it.
      if (state.jobs.get(id)?.lockedBy !== owner) return null;
      return change(state.jobs, id, (job) => ({ ...job, ...result, lockedUntil: null, lockedBy: null }));
    },
    async setEnabled(id, enabled) {
      const next = requireBoolean(enabled, "Job enabled");
      return change(state.jobs, id, (job) => ({ ...job, enabled: next }));
    },
  };
}

function deliveriesRepo(state: State, clock: Clock): Storage["deliveries"] {
  return {
    async add(input) {
      const record = buildDelivery(input, pickId(input?.id, clock, "Delivery id"), clock.nowIso());
      return insertNew(state.deliveries, record, "delivery");
    },
    async mark(id, status, error) {
      const next = requireOneOf(status, DELIVERY_STATUSES, "Delivery status");
      const message = optionalText(error, "Delivery error");
      return change(state.deliveries, id, (delivery) => ({ ...delivery, status: next, error: message }));
    },
    async list(options) {
      const target = optionalText(options?.target, "Delivery target filter");
      const channel = optionalText(options?.channel, "Delivery channel filter");
      const since = optionalIso(options?.since, "Delivery since");
      const limit = normalizeLimit(options?.limit, null);
      const deliveries = [...state.deliveries.values()].filter(
        (d) =>
          (target === null || d.target === target) &&
          (channel === null || d.channel === channel) &&
          (since === null || d.createdAt >= since),
      );
      return takeLimit(newestFirst(deliveries, (d) => d.createdAt), limit).map(copy);
    },
  };
}
