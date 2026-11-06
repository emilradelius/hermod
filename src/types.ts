/**
 * The shared contract of the Hermod runtime. Every module codes against these types.
 *
 * Rules that the types encode:
 * - API data uses the SDK's own (beta) types; we call `client.beta.messages.*`.
 * - The agent only proposes: memory and skill changes become proposals unless a store's owner allows add-only writes.
 * - Effort is always explicit. Thinking is adaptive and never disabled.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

// ─── SDK types (beta family) ────────────────────────────────────────────────────────────────────────────────

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Message = Anthropic.Beta.BetaMessage;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
export type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
export type ToolParam = Anthropic.Beta.BetaTool;
export type TextBlockParam = Anthropic.Beta.BetaTextBlockParam;
export type Usage = Anthropic.Beta.BetaUsage;
export type StopReason = Anthropic.Beta.BetaStopReason;
export type Effort = NonNullable<Anthropic.Beta.BetaOutputConfig["effort"]>;

export type Id = string;
/** ISO 8601 timestamp in UTC, e.g. "2026-11-05T20:00:00.000Z". */
export type IsoTime = string;

// ─── Model client ───────────────────────────────────────────────────────────────────────────────────────────

/** What the loop asks for; the client turns it into an SDK request (see src/model/client.ts). */
export interface ModelRequest {
  model: string;
  /** Stable blocks first; the client puts cache breakpoints on them. Volatile content goes in `messages`. */
  system: TextBlockParam[];
  messages: MessageParam[];
  /** Deterministic order (the registry sorts by name), so the prompt cache stays warm. */
  tools?: ToolParam[];
  maxTokens: number;
  /** Always explicit (Opus 5.5 defaults to "medium" if omitted; we never rely on defaults). */
  effort: Effort;
  /** Use the server-side refusal fallback where the model supports it (default true). */
  refusalFallback?: boolean;
  /** Thinking display; thinking itself is always adaptive. Default "omitted". */
  thinkingDisplay?: "summarized" | "omitted";
  signal?: AbortSignal;
  /** Why this call is made; used for cost reports and tests. */
  purpose?: CallPurpose;
}

export type CallPurpose = "main" | "review" | "summary" | "delegate" | "job" | "eval";

export interface StreamCallbacks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  onToolUse?(block: { id: string; name: string }): void;
  onMessage?(message: Message): void;
}

export interface ModelClient {
  /** One model call (streamed internally); resolves with the final message. Throws SDK errors as-is. */
  complete(req: ModelRequest, callbacks?: StreamCallbacks): Promise<Message>;
  /** Optional input-token count for a request (no output). */
  countTokens?(req: Omit<ModelRequest, "maxTokens">): Promise<number>;
}

// ─── Agents and modes ───────────────────────────────────────────────────────────────────────────────────────

/** off: nothing runs (no data, no API calls). shadow: drafts only, side effects never run, a person scores them.
 * supervised: side effects become proposals a person approves. autonomous: side effects run, except tainted or
 * approval-required calls, and the hard denylist always applies. */
export type AgentMode = "off" | "shadow" | "supervised" | "autonomous";

/** How a person scored a draft in shadow mode: sent as-is / small edit / wrong. */
export type DraftScore = "as_is" | "small_edit" | "wrong";

export interface AgentRecord {
  id: Id;
  name: string;
  mode: AgentMode;
  /** Shadow-mode accuracy bar (0..1) a person sets; promotion is never automatic. */
  accuracyBar: number;
  /** Minimum scored drafts before the bar can be met. */
  minSamples: number;
  /** Hard monthly cost cap in USD across all sessions of this agent; null = no cap. */
  monthlyCostCapUsd: number | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export type NewAgent = Pick<AgentRecord, "id" | "name"> &
  Partial<Pick<AgentRecord, "mode" | "accuracyBar" | "minSamples" | "monthlyCostCapUsd">>;

// ─── Tools ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a tool may do. Sub-agents and unattended runs remove capabilities from the registry.
 * - read: reads data, no side effects.
 * - memory.write / skills.write: changes knowledge (always through MemoryService / proposals).
 * - internal.write: changes the app's own data.  - external.write: changes something outside the app.
 * - messaging: sends a message to a person. No built-in tool has it; the registry refuses it unless the app opts
 *   in for messages to the owner only.  - scheduling: creates or changes jobs.  - delegation: runs a sub-agent.
 */
export type ToolCapability =
  | "read"
  | "memory.write"
  | "skills.write"
  | "internal.write"
  | "external.write"
  | "messaging"
  | "scheduling"
  | "delegation";

export interface ToolContext {
  agentId: Id;
  sessionId: Id;
  mode: AgentMode;
  /** A person is present and can answer (false for scheduled runs). */
  attended: boolean;
  /**
   * Untrusted text is in the conversation the model sees, in this run or an earlier run of the session; it stays set
   * for the rest of the session.
   */
  tainted: boolean;
  storage: Storage;
  now(): Date;
  newId(): Id;
  signal?: AbortSignal;
  /** Append an audit entry attributed to this agent and session. */
  audit(action: string, target: string, details?: Record<string, unknown>): Promise<void>;
  /** Set by the loop for the delegate tool only. */
  runChild?(task: string, opts?: { toolsets?: string[]; maxCostUsd?: number }): Promise<string>;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** ^[a-zA-Z0-9_-]{1,64}$ */
  name: string;
  description: string;
  /** Zod schema of the input; converted to JSON Schema for the API and used to validate every call. */
  input: S;
  /** No side effects; may run in parallel with other read-only calls. */
  readOnly: boolean;
  capabilities: ToolCapability[];
  /** Output comes from outside (web, user files, MCP, e-mail): it is wrapped as untrusted and taints the session. */
  untrustedOutput?: boolean;
  /** Always needs a person's approval, even in autonomous mode. */
  requiresApproval?: boolean;
  run(input: z.infer<S>, ctx: ToolContext): Promise<unknown> | unknown;
}

export interface Toolset {
  name: string;
  tools: ToolDef[];
}

// ─── Safety ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Redactor = (text: string) => string;

export interface InjectionFinding {
  id: string;
  severity: "error" | "warn";
  message: string;
  index: number;
  excerpt: string;
}

export type ApprovalDecision = "allow" | "deny" | "propose";

export interface ApprovalContext {
  mode: AgentMode;
  attended: boolean;
  /**
   * Untrusted text is in the conversation the model sees, in this run or an earlier run of the session; it stays set
   * for the rest of the session.
   */
  tainted: boolean;
  tool: ToolDef;
  input: unknown;
}

export interface ApprovalPolicy {
  decide(ctx: ApprovalContext): { decision: ApprovalDecision; reason: string };
}

// ─── Sessions and messages ──────────────────────────────────────────────────────────────────────────────────

export type SessionKind = "chat" | "job" | "review" | "delegate" | "eval";
export type SessionStatus = "running" | "done" | "error" | "aborted";

export interface SessionCounters {
  userTurns: number;
  toolIterations: number;
  /** userTurns at the last memory review. */
  lastMemoryReviewTurn: number;
  /** toolIterations at the last skill review. */
  lastSkillReviewIteration: number;
}

export interface SessionRecord {
  id: Id;
  agentId: Id;
  kind: SessionKind;
  parentId: Id | null;
  attended: boolean;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  status: SessionStatus;
  /** Frozen at session start; never changes during the session. */
  memorySnapshot: string;
  /** Frozen at session start. */
  skillsIndex: string;
  counters: SessionCounters;
  meta: Record<string, unknown>;
}

export type NewSession = Pick<SessionRecord, "agentId" | "kind" | "attended" | "memorySnapshot" | "skillsIndex"> &
  Partial<Pick<SessionRecord, "id" | "parentId" | "meta" | "startedAt">>;

export interface MessageRecord {
  id: Id;
  sessionId: Id;
  /** 0-based order within the session. */
  seq: number;
  role: "user" | "assistant" | "system";
  /** The exact content blocks as sent/received (thinking blocks preserved unchanged). */
  content: MessageParam["content"];
  /** Plain searchable text (tool output truncated to 8 KB). */
  text: string;
  createdAt: IsoTime;
}

export interface SearchHit {
  sessionId: Id;
  messageId: Id;
  seq: number;
  role: MessageRecord["role"];
  /** A short excerpt around the match. */
  snippet: string;
  /** Higher is better (adapter-specific scale). */
  score: number;
  createdAt: IsoTime;
}

// ─── Memory ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Entries are declarative facts joined by MEMORY_SEPARATOR. */
export const MEMORY_SEPARATOR = "\n§\n";

export interface MemoryStoreRecord {
  id: Id;
  agentId: Id;
  /** "memory" (environment and project facts), "user" (facts about the user), or an app-defined name. */
  name: string;
  capChars: number;
  /** "add": the store's owner allows add-only batches to apply without approval. Default "none". */
  autoApply: "none" | "add";
  /** Entries joined by MEMORY_SEPARATOR. */
  content: string;
  /** Incremented on every write; writes check it (optimistic concurrency). */
  version: number;
  updatedAt: IsoTime;
}

export type MemoryOp =
  | { op: "add"; text: string }
  | { op: "patch"; old: string; new: string }
  | { op: "remove"; old: string };

// ─── Skills ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SkillStatus = "active" | "stale" | "archived";

export interface SkillRecord {
  id: Id;
  agentId: Id;
  /** agentskills.io rules: ^[a-z0-9]+(-[a-z0-9]+)*$, at most 64 characters. */
  name: string;
  /** At most 1,024 characters; its first sentence (≤ 60) is the index line. */
  description: string;
  body: string;
  version: number;
  status: SkillStatus;
  pinned: boolean;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  lastUsedAt: IsoTime | null;
  counters: { views: number; uses: number; patches: number };
}

export interface SkillVersionRecord {
  skillId: Id;
  version: number;
  description: string;
  body: string;
  createdAt: IsoTime;
  createdBy: string;
  proposalId: Id | null;
}

// ─── Proposals (the review inbox) ───────────────────────────────────────────────────────────────────────────

export type ProposalKind = "memory" | "skill" | "action";
export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "expired";

/** What a proposal points to as its grounding. Code verifies message quotes before a proposal is created. */
export interface Evidence {
  kind: "message" | "tool_result" | "commit" | "test" | "log";
  /** A message id, a commit sha, a test name or a log line id. */
  ref: string;
  /** For kind "message"/"tool_result": a verbatim excerpt of that message's text. */
  quote?: string;
}

export type SkillChange =
  | { change: "patch"; old: string; new: string }
  | { change: "add_reference"; title: string; text: string }
  | { change: "create"; description: string; body: string };

export type ProposalPayload =
  | { kind: "memory"; store: string; ops: MemoryOp[] }
  | { kind: "skill"; skill: string; changes: SkillChange[] }
  | { kind: "action"; tool: string; input: unknown; draftText?: string };

export interface ProposalRecord {
  id: Id;
  agentId: Id;
  sessionId: Id | null;
  kind: ProposalKind;
  /** Memory store name, skill name, or tool name. */
  target: string;
  payload: ProposalPayload;
  evidence: Evidence[];
  rationale: string;
  status: ProposalStatus;
  /** "review", "agent:<id>", "job:<id>" … */
  createdBy: string;
  createdAt: IsoTime;
  decidedAt: IsoTime | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /** Shadow-mode score set by a person. */
  score: DraftScore | null;
  /** Created while the agent was in shadow mode (a draft that was never run). */
  shadow: boolean;
}

export type NewProposal = Pick<
  ProposalRecord,
  "agentId" | "sessionId" | "kind" | "target" | "payload" | "evidence" | "rationale" | "createdBy"
> &
  Partial<Pick<ProposalRecord, "id" | "shadow">>;

// ─── Audit, costs ───────────────────────────────────────────────────────────────────────────────────────────

/** Append-only. There is deliberately no update or delete API. */
export interface AuditRecord {
  id: Id;
  at: IsoTime;
  /** "agent:<id>", "user:<id>", "system", "review", "job:<id>". */
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export interface CostRecord {
  id: Id;
  at: IsoTime;
  agentId: Id;
  sessionId: Id | null;
  model: string;
  purpose: CallPurpose;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

// ─── Jobs and deliveries ────────────────────────────────────────────────────────────────────────────────────

export interface JobRecord {
  id: Id;
  agentId: Id;
  name: string;
  /** 5-field cron expression, evaluated in `timeZone`. */
  schedule: string;
  /** IANA time zone, e.g. "Europe/Stockholm". */
  timeZone: string;
  prompt: string;
  /** Skill names attached to every run. */
  skills: string[];
  /** Name of a registered pre-step (never code); its output becomes context. */
  preStep: string | null;
  /** Delivery target resolved when the job fires, e.g. "webpush:owner", "inapp:owner", "telegram:<chat>". */
  deliver: string;
  enabled: boolean;
  nextRunAt: IsoTime | null;
  lastRunAt: IsoTime | null;
  lastStatus: "ok" | "silent" | "skipped" | "error" | null;
  lastError: string | null;
  /** Consecutive failures (for backoff). */
  failures: number;
  lockedUntil: IsoTime | null;
  lockedBy: string | null;
}

export type NewJob = Pick<JobRecord, "agentId" | "name" | "schedule" | "timeZone" | "prompt" | "deliver"> &
  Partial<Pick<JobRecord, "id" | "skills" | "preStep" | "enabled" | "nextRunAt">>;

export interface DeliveryRecord {
  id: Id;
  channel: string;
  target: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: IsoTime;
  status: "queued" | "sent" | "failed";
  error: string | null;
  jobId: Id | null;
}

export interface DeliveryMessage {
  title: string;
  body: string;
  url?: string;
  /** Replaces an earlier notification with the same tag (web push). */
  tag?: string;
}

export interface DeliveryResult {
  ok: boolean;
  /** How many endpoints received it (e.g. several push subscriptions). */
  delivered: number;
  error?: string;
}

/** A delivery channel. Channels are used by application code and the scheduler, never exposed as tools. */
export interface Channel {
  readonly name: string;
  send(target: string, message: DeliveryMessage, meta?: { jobId?: Id }): Promise<DeliveryResult>;
}

// ─── Storage ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListOptions {
  limit?: number;
}

/** One interface, three adapters (in-memory, SQLite, Postgres), one conformance suite. All methods are async. */
export interface Storage {
  /** Create or upgrade tables. Idempotent. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  agents: {
    upsert(agent: NewAgent): Promise<AgentRecord>;
    get(id: Id): Promise<AgentRecord | null>;
    list(): Promise<AgentRecord[]>;
    /** Low-level; use modes.setMode, which audits. */
    update(
      id: Id,
      patch: Partial<Pick<AgentRecord, "mode" | "accuracyBar" | "minSamples" | "monthlyCostCapUsd">>,
    ): Promise<AgentRecord | null>;
  };

  sessions: {
    create(session: NewSession): Promise<SessionRecord>;
    get(id: Id): Promise<SessionRecord | null>;
    update(
      id: Id,
      patch: Partial<Pick<SessionRecord, "endedAt" | "status" | "counters" | "meta">>,
    ): Promise<SessionRecord | null>;
    listByAgent(agentId: Id, options?: ListOptions & { kind?: SessionKind }): Promise<SessionRecord[]>;
  };

  messages: {
    /** Appends with the next seq for the session. Append-only: no update or delete. */
    append(sessionId: Id, message: Pick<MessageRecord, "role" | "content" | "text">): Promise<MessageRecord>;
    list(sessionId: Id): Promise<MessageRecord[]>;
    get(id: Id): Promise<MessageRecord | null>;
    /** Full-text search over `text`. The query is plain words (never FTS/tsquery syntax from the caller). */
    search(
      query: string,
      options?: ListOptions & { agentId?: Id; excludeSessionId?: Id },
    ): Promise<SearchHit[]>;
  };

  memory: {
    ensureStore(
      agentId: Id,
      name: string,
      defaults: Pick<MemoryStoreRecord, "capChars" | "autoApply">,
    ): Promise<MemoryStoreRecord>;
    getStore(agentId: Id, name: string): Promise<MemoryStoreRecord | null>;
    listStores(agentId: Id): Promise<MemoryStoreRecord[]>;
    /** Writes only if the stored version equals expectedVersion; returns null on a version conflict. */
    writeContent(id: Id, content: string, expectedVersion: number): Promise<MemoryStoreRecord | null>;
    setPolicy(id: Id, policy: Partial<Pick<MemoryStoreRecord, "capChars" | "autoApply">>): Promise<MemoryStoreRecord | null>;
  };

  skills: {
    create(
      skill: Pick<SkillRecord, "agentId" | "name" | "description" | "body"> & { createdBy: string; pinned?: boolean },
    ): Promise<SkillRecord>;
    get(agentId: Id, name: string): Promise<SkillRecord | null>;
    list(agentId: Id, options?: { status?: SkillStatus }): Promise<SkillRecord[]>;
    /** Writes a new version row and bumps `version`; never overwrites history. */
    update(
      id: Id,
      change: Pick<SkillRecord, "description" | "body">,
      meta: { createdBy: string; proposalId: Id | null },
    ): Promise<SkillRecord | null>;
    setStatus(id: Id, status: SkillStatus): Promise<SkillRecord | null>;
    setPinned(id: Id, pinned: boolean): Promise<SkillRecord | null>;
    bump(id: Id, counter: "views" | "uses" | "patches", at: IsoTime): Promise<void>;
    versions(id: Id): Promise<SkillVersionRecord[]>;
  };

  proposals: {
    create(proposal: NewProposal): Promise<ProposalRecord>;
    get(id: Id): Promise<ProposalRecord | null>;
    list(
      options?: ListOptions & { agentId?: Id; status?: ProposalStatus; kind?: ProposalKind; sessionId?: Id },
    ): Promise<ProposalRecord[]>;
    /** Atomic compare-and-set: changes status only if the current status is one of `from`. Null otherwise. */
    transition(
      id: Id,
      from: ProposalStatus[],
      to: ProposalStatus,
      decision: { at: IsoTime; by: string; note?: string | null },
    ): Promise<ProposalRecord | null>;
    setScore(id: Id, score: DraftScore): Promise<ProposalRecord | null>;
  };

  audit: {
    append(entry: Omit<AuditRecord, "id"> & { id?: Id }): Promise<AuditRecord>;
    list(options?: ListOptions & { target?: string; actor?: string; action?: string }): Promise<AuditRecord[]>;
  };

  costs: {
    add(cost: Omit<CostRecord, "id"> & { id?: Id }): Promise<CostRecord>;
    /** Sum of costUsd for an agent since a time (inclusive). */
    sum(options: { agentId: Id; since: IsoTime }): Promise<number>;
    list(options?: ListOptions & { agentId?: Id; sessionId?: Id }): Promise<CostRecord[]>;
  };

  jobs: {
    upsert(job: NewJob): Promise<JobRecord>;
    get(id: Id): Promise<JobRecord | null>;
    list(options?: { agentId?: Id }): Promise<JobRecord[]>;
    /** Atomically leases up to `limit` enabled jobs with nextRunAt ≤ now that are not leased (or whose lease
     * expired). Two concurrent claimers never get the same job. */
    claimDue(now: IsoTime, options: { leaseMs: number; worker: string; limit?: number }): Promise<JobRecord[]>;
    /** Records a run's outcome and releases the lease. */
    finish(
      id: Id,
      outcome: Pick<JobRecord, "lastRunAt" | "lastStatus" | "lastError" | "nextRunAt" | "failures">,
    ): Promise<JobRecord | null>;
    setEnabled(id: Id, enabled: boolean): Promise<JobRecord | null>;
  };

  deliveries: {
    add(delivery: Omit<DeliveryRecord, "id" | "createdAt" | "status" | "error"> & { id?: Id }): Promise<DeliveryRecord>;
    mark(id: Id, status: DeliveryRecord["status"], error?: string | null): Promise<DeliveryRecord | null>;
    list(options: ListOptions & { target?: string; channel?: string; since?: IsoTime }): Promise<DeliveryRecord[]>;
  };
}

// ─── Running an agent ───────────────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  agentId: Id;
  /** The agent's own instructions (stable; part of the cached system prefix). */
  systemPrompt: string;
  /** Default "claude-opus-5-5". */
  model?: string;
  /** Default "medium" (always sent explicitly). */
  effort?: Effort;
  /** Client-side fallback model after retries are exhausted on overload/5xx. Default none. */
  fallbackModel?: string | null;
  /** Default 16_000. */
  maxTokens?: number;
  toolsets?: Toolset[];
  budget?: {
    /** Model calls per run. Default 20. */
    maxIterations?: number;
    /** USD per run. Default 1.00. */
    maxCostUsd?: number;
    /** Wall clock per run. Default none. */
    maxWallMs?: number;
  };
  context?: {
    /** The window compression works against (not the model maximum). Default 200_000 tokens. */
    windowTokens?: number;
    /** Compress when the last prompt reaches this fraction of windowTokens. Default 0.5. */
    compressAtFraction?: number;
    /** Tokens of recent conversation kept after compression. Default 20_000. */
    tailTokens?: number;
    /** Default "claude-haiku-5-5". */
    summaryModel?: string;
  };
  /** Applied to everything that enters the conversation or storage. Default: secrets only. */
  redactor?: Redactor;
  approvals?: ApprovalPolicy;
  /** Default 20_000 characters. */
  maxToolOutputChars?: number;
  /** Memory stores loaded into the frozen snapshot. Default ["memory", "user"]. */
  memoryStores?: string[];
  /** Extra skills whose full bodies are attached to the system prompt (scheduled jobs). */
  attachSkills?: string[];
}

export interface RunDeps {
  storage: Storage;
  model: ModelClient;
  now?: () => Date;
  newId?: () => Id;
  /** Sleep used by retries (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export type LoopPhase = "prepare" | "request" | "tools" | "compress" | "finish";

export interface LoopCallbacks {
  onPhase?(phase: LoopPhase): void;
  onToolCall?(event: ToolCallRecord): void;
  onCost?(event: { usd: number; totalUsd: number; model: string }): void;
}

export interface RunInput {
  /** Continue this session (chat); otherwise a new session is created. */
  sessionId?: Id;
  kind?: SessionKind;
  /** Default true for chat, false for job. */
  attended?: boolean;
  parentSessionId?: Id;
  /** The genuine user message for this turn. */
  userMessage: string;
  /** Volatile context for this turn (time, today's data). Goes into the user message, never the system prompt. */
  context?: string;
  callbacks?: StreamCallbacks & LoopCallbacks;
  signal?: AbortSignal;
}

export type RunEnd =
  | "end_turn"
  | "refusal"
  | "max_tokens"
  | "budget_iterations"
  | "budget_cost"
  | "budget_time"
  | "error"
  | "aborted";

export type ErrorAction = "retry" | "fallback" | "compress" | "abort";

export interface ClassifiedError {
  kind:
    | "rate_limit"
    | "overloaded"
    | "server"
    | "connection"
    | "timeout"
    | "context_too_long"
    | "auth"
    | "permission"
    | "not_found"
    | "bad_request"
    | "aborted"
    | "unknown";
  action: ErrorAction;
  status?: number;
  retryAfterMs?: number;
  message: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  decision: ApprovalDecision;
  ok: boolean;
  error?: string;
  proposalId?: Id;
  durationMs: number;
}

export interface LoopState {
  agentId: Id;
  sessionId: Id;
  phase: LoopPhase;
  /** Model calls made in this run. */
  iteration: number;
  model: string;
  messages: MessageParam[];
  costUsd: number;
  /**
   * Untrusted text is in the conversation the model sees, in this run or an earlier run of the session; it stays set
   * for the rest of the session.
   */
  tainted: boolean;
  lastPromptTokens: number;
  compressions: number;
  /** Proposals created during this run (see RunResult.proposals). */
  proposals: Id[];
  toolCalls: ToolCallRecord[];
  errors: ClassifiedError[];
  end: RunEnd | null;
  finalText: string;
  refusalCategory: string | null;
}

export interface RunResult {
  sessionId: Id;
  text: string;
  end: RunEnd;
  refusalCategory: string | null;
  costUsd: number;
  iterations: number;
  /**
   * Every proposal created during this run in its session (action proposals of the loop, and the memory and skill
   * proposals the knowledge tools made), then a delegate child's, each once, in creation order.
   */
  proposals: Id[];
  toolCalls: ToolCallRecord[];
  errors: ClassifiedError[];
}

/** Thrown by runAgent before any storage write or API call when the agent's mode is "off". */
export class AgentOffError extends Error {
  readonly agentId: Id;
  constructor(agentId: Id) {
    super(`Agent "${agentId}" is off: nothing runs, no data is written and no API call is made.`);
    this.name = "AgentOffError";
    this.agentId = agentId;
  }
}

// ─── Scheduling and learning ────────────────────────────────────────────────────────────────────────────────

/** A registered pre-step: returns context text for the run, or null to skip the run silently (nothing to do). */
export type PreStep = (ctx: { job: JobRecord; now: Date; storage: Storage }) => Promise<string | null>;

export interface TickReport {
  claimed: number;
  ran: number;
  silent: number;
  skipped: number;
  delivered: number;
  failed: number;
  jobs: Array<{ id: Id; name: string; status: NonNullable<JobRecord["lastStatus"]>; error?: string }>;
}

export interface ReviewResult {
  sessionId: Id;
  proposals: Id[];
  /** Proposals the code refused (ungrounded quote, injection, over cap, …) with the reason. */
  refused: Array<{ reason: string }>;
  steps: number;
  costUsd: number;
}
