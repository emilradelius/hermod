/**
 * The post-session review: a FORK of the agent reads one finished conversation and proposes memory or skill
 * changes. It never changes anything on its own authority.
 *
 * - It runs with runAgent in a new session (kind "review", parentId = the reviewed session, attended false) on the
 *   background model (DEFAULTS.background, effort low), at most 16 model calls.
 * - Its only tools: `memory` and `skill_propose` (writing through MemoryService / ProposalService, so they become
 *   proposals created by "review"), `skill_list` / `skill_view` (read; viewing here does not count as using a
 *   skill), and two read-only tools of its own: `session_read` (the reviewed conversation, paged, with message ids)
 *   and `session_search` (earlier sessions). No messaging, scheduling or delegation tool exists in the run.
 * - Every write must cite { messageId, quote } from the REVIEWED conversation; verifyEvidence checks each quote
 *   (requireGrounding), and anything that does not hold up is refused with the reason, which the reviewer sees.
 * - Direct writes: only an add-only batch to a store whose owner allows add-only writes (autoApply "add"), and only
 *   when the reviewed session is an attended chat and every quote comes from a genuine user message's own words (not
 *   a tool result, not the assistant, not the app's context prefix). Patches and removals, shadow-mode agents, jobs,
 *   delegates and facts grounded in tool output always become proposals.
 * - The agent being off means off: runAgent throws AgentOffError before any write or model call.
 */
import { z } from "zod";
import { runAgentWith, type LoopDeps } from "../loop/agent.js";
import { unattendedPolicy } from "../loop/job-runner.js";
import { knowledgeDeps } from "../memory/knowledge-deps.js";
import type { MemoryService } from "../memory/memory.js";
import { DEFAULTS } from "../model/models.js";
import { ProposalRefusedError } from "../proposals/errors.js";
import { normalizeWhitespace } from "../proposals/evidence.js";
import type { ProposalService } from "../proposals/proposals.js";
import { createApprovalPolicy } from "../safety/approvals.js";
import type { SkillService } from "../skills/skills.js";
import { memoryOpSchema } from "../tools/builtin/memory-tool.js";
import { formatSearchResult } from "../tools/builtin/session-search.js";
import { makeSkillTools, skillChangeSchema } from "../tools/builtin/skill-tools.js";
import type {
  AgentConfig,
  Evidence,
  Id,
  MemoryOp,
  MessageRecord,
  ModelClient,
  RunEnd,
  ReviewResult,
  SessionRecord,
  SkillChange,
  Storage,
  ToolContext,
  ToolDef,
  Toolset,
} from "../types.js";
import { REVIEW_SYSTEM_PROMPT, reviewUserMessage } from "./review-prompt.js";

/** Hermes's cap on the review fork. */
export const MAX_REVIEW_ITERATIONS = 16;
export const DEFAULT_REVIEW_COST_USD = 0.25;
/** The actor of every proposal and audit entry the review makes. */
export const REVIEW_ACTOR = "review";
export const REVIEW_TOOLSET = "review";
export const SESSION_READ_DEFAULT_LIMIT = 25;
export const SESSION_READ_MAX_LIMIT = 50;
/** Characters of one message shown in a page (a single message can be read in full with messageId). */
export const SESSION_READ_MESSAGE_CHARS = 2_000;
export const SESSION_READ_FULL_MESSAGE_CHARS = 8_000;
export const SESSION_READ_PAGE_CHARS = 15_000;

export interface ReviewDeps {
  storage: Storage;
  model: ModelClient;
  memory: MemoryService;
  skills: SkillService;
  proposals: ProposalService;
  now?: () => Date;
  newId?: () => Id;
  /** Sleep used by retries (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReviewOptions {
  /** Model calls, 1..16 (default 16). */
  maxIterations?: number;
  /** USD for the whole review (default 0.25). */
  maxCostUsd?: number;
  /** What to look for (default both; usually from shouldReview). */
  focus?: { memory: boolean; skills: boolean };
  signal?: AbortSignal;
}

export interface ReviewOutcome extends ReviewResult {
  reviewedSessionId: Id;
  /** Add-only batches written directly (store allows add-only writes, grounded in the user's own words). */
  applied: Array<{ store: string; ops: number }>;
  end: RunEnd;
  /** The reviewer's last text (e.g. "Nothing to save."). */
  text: string;
}

/** What the review tools record while the fork runs. */
export interface ReviewLedger {
  proposals: Id[];
  refused: Array<{ reason: string }>;
  applied: Array<{ store: string; ops: number }>;
}

const evidenceSchema = z
  .array(
    z.object({
      messageId: z.string().min(1).max(200).describe("Id of a message of the reviewed conversation (from session_read)."),
      quote: z.string().min(1).max(300).describe("Words copied exactly from that message."),
    }),
  )
  .min(1)
  .max(10)
  .describe("Required: where the conversation shows this. Every quote is checked.");

export const reviewMemoryInput = z.object({
  store: z.string().min(1).max(64).describe('"memory" (environment and project facts), "user" (facts about the user), or another store.'),
  ops: z.array(memoryOpSchema).min(1).max(10).describe("Applied together: all or nothing."),
  evidence: evidenceSchema,
  rationale: z.string().min(1).max(1000).describe("Why this is worth keeping (shown to the person who decides)."),
});

export const reviewSkillProposeInput = z.object({
  skill: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("The skill's name (lowercase letters, digits and hyphens)."),
  changes: z.array(skillChangeSchema).min(1).max(5),
  evidence: evidenceSchema,
  rationale: z.string().min(1).max(1000).describe("What went wrong or was missing, and why this change fixes it."),
});

export const sessionReadInput = z.object({
  offset: z.number().int().min(0).optional().describe("The message number (#) to start from (default 0)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SESSION_READ_MAX_LIMIT)
    .optional()
    .describe(`Messages per page (default ${SESSION_READ_DEFAULT_LIMIT}).`),
  messageId: z.string().min(1).max(200).optional().describe("Read this one message in full instead of a page."),
});

export const reviewSearchInput = z.object({
  query: z.string().min(1).max(500).describe("Plain words to look for (no special syntax)."),
  limit: z.number().int().min(1).max(10).optional().describe("Matches to return (default 5)."),
});

/**
 * Reviews one finished session and returns the proposals it created and the attempts the code refused.
 * Throws for a missing session, for a session that is itself a review, and AgentOffError when the agent is off.
 */
export async function reviewSession(sessionId: Id, deps: ReviewDeps, options: ReviewOptions = {}): Promise<ReviewOutcome> {
  if (!deps || !deps.storage || typeof deps.model?.complete !== "function" || !deps.memory || !deps.skills || !deps.proposals) {
    throw new TypeError("reviewSession needs { storage, model, memory, skills, proposals }.");
  }
  const maxIterations = options.maxIterations ?? MAX_REVIEW_ITERATIONS;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_REVIEW_ITERATIONS) {
    throw new TypeError(`reviewSession: maxIterations must be a whole number from 1 to ${MAX_REVIEW_ITERATIONS}.`);
  }
  const maxCostUsd = options.maxCostUsd ?? DEFAULT_REVIEW_COST_USD;
  if (typeof maxCostUsd !== "number" || !(maxCostUsd >= 0)) throw new TypeError("reviewSession: maxCostUsd must be 0 or more.");

  const { storage } = deps;
  // Reads only before runAgent: an agent that is off gets no write and no model call (runAgent checks the mode).
  const reviewed = await storage.sessions.get(sessionId);
  if (!reviewed) throw new Error(`reviewSession: there is no session "${sessionId}".`);
  if (reviewed.kind === "review") throw new Error("reviewSession: a review session is not reviewed again.");
  const messages = await storage.messages.list(reviewed.id);
  const stores = await storage.memory.listStores(reviewed.agentId);

  const ledger: ReviewLedger = { proposals: [], refused: [], applied: [] };
  const toolset = reviewToolset({ ...deps, reviewed, ledger });
  const config: AgentConfig = {
    agentId: reviewed.agentId,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: DEFAULTS.background.model,
    effort: DEFAULTS.background.effort,
    maxTokens: DEFAULTS.background.maxTokens,
    fallbackModel: null,
    toolsets: [toolset],
    budget: { maxIterations, maxCostUsd },
    context: { summaryModel: DEFAULTS.background.model },
    memoryStores: stores.map((store) => store.name),
    attachSkills: [],
    // Nobody is present: a call that would need a person's approval now is denied, never waited for.
    approvals: unattendedPolicy(createApprovalPolicy()),
  };
  const loopDeps: LoopDeps = {
    storage,
    model: deps.model,
    knowledge: knowledgeDeps({ memory: deps.memory, skills: deps.skills }),
  };
  if (deps.now) loopDeps.now = deps.now;
  if (deps.newId) loopDeps.newId = deps.newId;
  if (deps.sleep) loopDeps.sleep = deps.sleep;

  const result = await runAgentWith(
    config,
    {
      kind: "review",
      attended: false,
      parentSessionId: reviewed.id,
      userMessage: reviewUserMessage(reviewed, messages.length, stores, options.focus),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    loopDeps,
    { actor: REVIEW_ACTOR },
  );
  return {
    sessionId: result.sessionId,
    reviewedSessionId: reviewed.id,
    proposals: [...ledger.proposals],
    refused: [...ledger.refused],
    applied: [...ledger.applied],
    steps: result.iterations,
    costUsd: result.costUsd,
    end: result.end,
    text: result.text,
  };
}

// ─── the review toolset ─────────────────────────────────────────────────────────────────────────────────────

export interface ReviewToolsetDeps extends ReviewDeps {
  reviewed: SessionRecord;
  ledger: ReviewLedger;
}

/** The fork's only tools. Exported for tests and for apps that run a review their own way. */
export function reviewToolset(deps: ReviewToolsetDeps): Toolset {
  const [skillList] = makeSkillTools(deps.skills, deps.proposals);
  return {
    name: REVIEW_TOOLSET,
    tools: [
      makeReviewMemoryTool(deps),
      skillList as ToolDef,
      makeReviewSkillViewTool(deps.skills) as ToolDef,
      makeReviewSkillProposeTool(deps),
      makeSessionReadTool(deps.storage, deps.reviewed) as ToolDef,
      makeReviewSearchTool(deps.storage, deps.reviewed) as ToolDef,
    ],
  };
}

/** A genuine user message: role user and only text (no tool results, which come from tools). */
function isGenuineUserMessage(message: MessageRecord): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((block) => block.type === "text");
}

/** The loop puts volatile app context in front of the user's words as `<context>…</context>`; that part is not the user's. */
const CONTEXT_PREFIX = /^<context>\n[\s\S]*?\n<\/context>\n\n/;

/** The user's own words in a genuine user message (without the app's context prefix), whitespace-normalised. */
function ownWords(message: MessageRecord): string {
  return normalizeWhitespace(message.text.replace(CONTEXT_PREFIX, ""));
}

/** Only a person typed the user messages of an attended chat (a job's prompt carries pre-step output; a delegate's task is model text). */
function personWroteUserMessages(session: SessionRecord): boolean {
  return session.kind === "chat" && session.attended;
}

function hasToolResult(message: MessageRecord): boolean {
  const content = message.content;
  return Array.isArray(content) && content.some((block) => block.type === "tool_result");
}

type Grounding =
  | { ok: true; evidence: Evidence[]; allFromUser: boolean }
  | { ok: false; reason: string };

/**
 * Every cited message must belong to the reviewed conversation (the reviewer cannot cite its own messages or an
 * unrelated session). The quotes themselves are verified by verifyEvidence inside the services (requireGrounding).
 */
async function groundIn(
  storage: Storage,
  reviewed: SessionRecord,
  items: ReadonlyArray<{ messageId: string; quote: string }>,
): Promise<Grounding> {
  const evidence: Evidence[] = [];
  const problems: string[] = [];
  let allFromUser = true;
  for (const [index, item] of items.entries()) {
    const message = await storage.messages.get(item.messageId);
    if (!message || message.sessionId !== reviewed.id) {
      problems.push(
        `Evidence ${index + 1}: "${item.messageId}" is not a message of the reviewed conversation; cite an id that session_read shows.`,
      );
      continue;
    }
    if (!personWroteUserMessages(reviewed) || !isGenuineUserMessage(message) || !ownWords(message).includes(normalizeWhitespace(item.quote))) {
      allFromUser = false;
    }
    evidence.push({ kind: hasToolResult(message) ? "tool_result" : "message", ref: message.id, quote: item.quote });
  }
  if (evidence.length === 0 && problems.length === 0) problems.push("No evidence was given; cite the message that shows this.");
  return problems.length > 0 ? { ok: false, reason: problems.join(" ") } : { ok: true, evidence, allFromUser };
}

function refuse(ledger: ReviewLedger, reason: string): string {
  ledger.refused.push({ reason });
  return `Refused, nothing was saved or proposed: ${reason}`;
}

export function makeReviewMemoryTool(deps: ReviewToolsetDeps): ToolDef {
  const tool: ToolDef<typeof reviewMemoryInput> = {
    name: "memory",
    description: [
      "Propose durable facts for persistent memory: add, patch (replace a whole entry) or remove entries, in one batch.",
      "Every batch cites evidence from the reviewed conversation (message id and an exact quote); the code checks it.",
      "Write facts, not orders, and no dates or ids. A batch becomes a proposal a person approves; only an add-only",
      "batch to a store that allows it, grounded in the user's own words, is saved at once.",
    ].join(" "),
    input: reviewMemoryInput,
    readOnly: false,
    capabilities: ["memory.write"],
    async run(input, ctx: ToolContext) {
      const grounding = await groundIn(deps.storage, deps.reviewed, input.evidence);
      if (!grounding.ok) return refuse(deps.ledger, grounding.reason);
      const ops = input.ops as MemoryOp[];
      const result = await deps.memory.write({
        agentId: deps.reviewed.agentId,
        sessionId: deps.reviewed.id,
        store: input.store,
        ops,
        actor: REVIEW_ACTOR,
        unattended: true,
        evidence: grounding.evidence,
        rationale: input.rationale,
        requireGrounding: true,
        shadow: false,
        // Only the user's own words may write themselves into an add-only store; a shadow agent never writes.
        noAutoApply: !grounding.allFromUser || ctx.mode === "shadow",
      });
      switch (result.status) {
        case "applied":
          deps.ledger.applied.push({ store: input.store, ops: ops.length });
          return "Saved (the store allows add-only writes). It shows from the next session on.";
        case "proposed":
          if (result.proposalId) deps.ledger.proposals.push(result.proposalId);
          return `Proposed (id ${result.proposalId ?? "?"}), waiting for a person's approval.`;
        case "refused":
          return refuse(deps.ledger, result.error ?? "the batch was refused.");
      }
    },
  };
  return tool as ToolDef;
}

export function makeReviewSkillProposeTool(deps: ReviewToolsetDeps): ToolDef {
  const tool: ToolDef<typeof reviewSkillProposeInput> = {
    name: "skill_propose",
    description: [
      "Propose a change to a skill: patch its steps (preferred), add a reference section to an umbrella skill, or,",
      "only when nothing fits, create one. Read the skill with skill_view first. Cite evidence from the reviewed",
      "conversation (message id and an exact quote). Always a proposal: nothing changes until a person approves it.",
    ].join(" "),
    input: reviewSkillProposeInput,
    readOnly: false,
    capabilities: ["skills.write"],
    async run(input) {
      const grounding = await groundIn(deps.storage, deps.reviewed, input.evidence);
      if (!grounding.ok) return refuse(deps.ledger, grounding.reason);
      try {
        const proposal = await deps.proposals.create(
          {
            agentId: deps.reviewed.agentId,
            sessionId: deps.reviewed.id,
            kind: "skill",
            target: input.skill,
            payload: { kind: "skill", skill: input.skill, changes: input.changes as SkillChange[] },
            evidence: grounding.evidence,
            rationale: input.rationale,
            createdBy: REVIEW_ACTOR,
            shadow: false,
          },
          { requireGrounding: true },
        );
        deps.ledger.proposals.push(proposal.id);
        return `Proposed (id ${proposal.id}), waiting for a person's approval.`;
      } catch (error) {
        if (error instanceof ProposalRefusedError) return refuse(deps.ledger, error.problems.join(" "));
        throw error;
      }
    },
  };
  return tool as ToolDef;
}

/** skill_view for the reviewer: reads without counting a use (a review is not a use; the curator relies on it). */
export function makeReviewSkillViewTool(skills: SkillService): ToolDef<z.ZodObject<{ name: z.ZodString }>> {
  return {
    name: "skill_view",
    description: "Load a skill in full (its description and all its steps) before proposing a change to it.",
    input: z.object({ name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }),
    readOnly: true,
    capabilities: ["read"],
    async run(input, ctx) {
      const skill = await skills.get(ctx.agentId, input.name);
      if (!skill) throw new Error(`There is no skill named "${input.name}". Use skill_list to see the skills.`);
      return `# ${skill.name} (version ${skill.version}, ${skill.status})\n\n${skill.description}\n\n${skill.body}`;
    },
  };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[cut: ${text.length - max} more characters; read it in full with messageId]`;
}

function block(message: MessageRecord, max: number): string {
  const text = message.text.trim() === "" ? "(no text)" : clip(message.text, max);
  return `[#${message.seq} ${message.role} id=${message.id}]\n${text}`;
}

/** session_read: the reviewed conversation, paged, each message with its id. Its text is data (untrusted). */
export function makeSessionReadTool(storage: Storage, reviewed: SessionRecord): ToolDef<typeof sessionReadInput> {
  return {
    name: "session_read",
    description: [
      "Read the conversation under review, a page at a time. Each message shows its number (#), role and id; cite",
      "the id and words copied from its text as evidence. Page with offset; read one long message in full with",
      "messageId.",
    ].join(" "),
    input: sessionReadInput,
    readOnly: true,
    capabilities: ["read"],
    untrustedOutput: true,
    async run(input) {
      const messages = await storage.messages.list(reviewed.id);
      if (input.messageId !== undefined) {
        const one = messages.find((message) => message.id === input.messageId);
        if (!one) throw new Error(`"${input.messageId}" is not a message of the reviewed conversation.`);
        return block(one, SESSION_READ_FULL_MESSAGE_CHARS);
      }
      const offset = input.offset ?? 0;
      const limit = input.limit ?? SESSION_READ_DEFAULT_LIMIT;
      const page = messages.filter((message) => message.seq >= offset).slice(0, limit);
      if (page.length === 0) return `No messages from #${offset} on; the conversation has ${messages.length} messages.`;
      const parts: string[] = [];
      let size = 0;
      let shown = 0;
      for (const message of page) {
        const part = block(message, SESSION_READ_MESSAGE_CHARS);
        if (shown > 0 && size + part.length > SESSION_READ_PAGE_CHARS) break;
        parts.push(part);
        size += part.length + 2;
        shown += 1;
      }
      const last = page[shown - 1] as MessageRecord;
      const rest = messages.filter((message) => message.seq > last.seq).length;
      const header = `Conversation ${reviewed.id} (${reviewed.kind}): messages #${page[0]?.seq ?? offset} to #${last.seq} of ${messages.length}.`;
      const footer = rest > 0 ? `${rest} more messages: call session_read with offset ${last.seq + 1}.` : "End of the conversation.";
      return [header, ...parts, footer].join("\n\n");
    },
  };
}

/** session_search for the reviewer: earlier sessions of the agent (never review sessions), snippets only. */
export function makeReviewSearchTool(storage: Storage, reviewed: SessionRecord): ToolDef<typeof reviewSearchInput> {
  return {
    name: "session_search",
    description: [
      "Search the agent's earlier sessions with plain words, to check whether something recurs. Returns matching",
      "snippets with session and message ids. Only messages of the conversation under review can be cited as evidence.",
    ].join(" "),
    input: reviewSearchInput,
    readOnly: true,
    capabilities: ["read"],
    untrustedOutput: true,
    async run(input, ctx) {
      const limit = input.limit ?? 5;
      const hits = await storage.messages.search(input.query, {
        agentId: reviewed.agentId,
        excludeSessionId: ctx.sessionId,
        limit: limit * 3,
      });
      const kinds = new Map<Id, string | null>();
      const kept = [];
      for (const hit of hits) {
        if (!kinds.has(hit.sessionId)) kinds.set(hit.sessionId, (await storage.sessions.get(hit.sessionId))?.kind ?? null);
        const kind = kinds.get(hit.sessionId);
        if (kind === null || kind === "review") continue;
        kept.push(hit);
        if (kept.length >= limit) break;
      }
      return formatSearchResult(input.query, kept, []);
    },
  };
}

