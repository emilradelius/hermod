/**
 * runAgent: one agent turn (or a whole scheduled run), from the user's message to the final text.
 *
 * Phases: prepare → request → tools → (compress) → request → … → finish, all on ONE LoopState object.
 *
 * - prepare: the agent row must exist (a programmer error otherwise) and must not be "off" (AgentOffError, before
 *   any storage write or model call). An unattended run (a new session or a continued one) records
 *   meta.unattendedRun on the session row once; it is never cleared. A new session stores the memory snapshot and
 *   the skills index FROZEN on its row; a continued session reuses what is stored and never asks again. System prompt: [stable rules + untrusted
 *   rules + the agent's own prompt] [snapshot + index (+ attached skill bodies)], both stable for the session. The
 *   volatile context goes into the user message, in a <context> block. Everything new is redacted.
 *   Stricter default: RunInput.context is treated as outside text unless the app sets contextTrusted: true. It is
 *   wrapped with wrapUntrusted (source "app-context"), so a run with context starts tainted (an app's synced note or
 *   e-mail in the context must not count as the user's words, nor let injected text drive side effects).
 * - request: budgets are checked before every call (model calls, USD: the run's cap and the agent's monthly cap,
 *   wall clock). Before every attempt (retries, after a fallback-model switch, the compression summary) the month's
 *   spend is re-read and max_tokens is clamped so the call's worst-case cost fits under what is left (./budget.ts);
 *   a call that would be left with too few tokens is not made and the run ends with "budget_cost". The prompt size
 *   is conservative (non-ASCII text, the last real prompt size, the long-prompt tier when it could apply), a request
 *   with the server-side refusal fallback keeps it only when two full attempts fit, and each call reserves its worst
 *   case against the monthly cap while it is in flight (per process). Every paid call leaves a cost row: a model
 *   PRICING does not list (e.g. in usage.iterations) is charged at the highest rates of any priced model (audit
 *   "cost.unpriced_model"), and usage that cannot be priced at all is charged the reserved worst case (audit
 *   "cost.uncomputable", the run ends "error"). Errors go through classifyError: retry with
 *   backoff (deps.sleep) up to 3 times, then the fallback model if one is configured (one switch, then up to 3
 *   more retries), compress then retry once for a context overflow, abort otherwise. A model or tool error ends the
 *   run with a reason; runAgent never throws for one.
 * - stop reasons: refusal → end "refusal" (no tools run, partial output discarded); pause_turn → append and send
 *   again; max_tokens with a tool_use → no tool runs, end "max_tokens"; end_turn → done. Assistant content is
 *   appended verbatim (thinking included), except the documented fallback echo rules (SDK facts §2.6).
 * - tools: see ./tools.ts (approval policy, proposals, parallel read-only calls, one user message of results). The
 *   agent's mode is re-read from storage before every call and every parallel group: one turned off during the
 *   round denies the rest, one set to shadow drafts them. A delegate's untrusted result is cut to fit
 *   maxToolOutputChars before it is wrapped.
 * - compress: see ./compress.ts (summary on the background model, restart from the summary, never edit a turn; a
 *   recent tail is replayed only at a real turn boundary, never in the middle of a tool loop).
 * - taint (./taint.ts): belongs to the conversation the model sees, so it lasts for the rest of the SESSION. A run
 *   starts tainted when its parent is (inheritTainted), when the session row says so (meta.tainted), when any stored
 *   message of the session carries an untrusted wrapper (sessions stored before the flag; before or after a
 *   compression marker, the same test as the review: isSessionTainted), or when its own user message does (context
 *   that is not marked trusted, or an app that wraps text with wrapUntrusted). The first time a run is tainted, the row records it once
 *   (meta.tainted, meta.taintedAt). A compression summary of a tainted conversation is wrapped as untrusted too.
 * - finish: session status, endedAt and counters; RunResult. RunResult.proposals lists every proposal created
 *   during the run in its session (action, memory and skill, whoever's tool made it, except the post-session
 *   review's) and a delegate child's, each once, in creation order.
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { backoff, classifyError } from "../model/errors.js";
import { estimateBudgetCost } from "../model/cost.js";
import { DEFAULTS, contextWindow, isEffort, pricingFor, supportsServerFallback } from "../model/models.js";
import { createApprovalPolicy } from "../safety/approvals.js";
import { secretsRedactor } from "../safety/redact.js";
import { createNonce, neutraliseDelimiters, UNTRUSTED_RULES, wrapUntrusted } from "../safety/untrusted.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  AgentOffError,
  type AgentConfig,
  type AgentMode,
  type CallPurpose,
  type ClassifiedError,
  type ContentBlock,
  type Effort,
  type Id,
  type LoopPhase,
  type LoopState,
  type Message,
  type MessageParam,
  type MessageRecord,
  type ModelRequest,
  type RunDeps,
  type RunEnd,
  type RunInput,
  type RunResult,
  type SessionCounters,
  type SessionKind,
  type SessionRecord,
  type StreamCallbacks,
  type TextBlockParam,
  type ToolContext,
  type ToolDef,
  type ToolParam,
  type ToolResultBlockParam,
} from "../types.js";
import {
  availableAfterRead,
  availableUsd,
  budgetStop,
  clampMaxTokens,
  createBudget,
  promptSize,
  readMonthSpend,
  reserveUsd,
  wallClockUsed,
  type Budget,
  type PromptSize,
} from "./budget.js";
import { COMPRESSION_MARKER, compressConversation, estimatePromptTokens, estimateTokens, hasPendingToolUse } from "./compress.js";
import { DELEGATE_EXCLUDED_CAPABILITIES, DELEGATE_RESULT_CHARS, DELEGATE_WRAPPER_ROOM, delegateSettingsOf } from "./delegate.js";
import { storageKnowledge, type KnowledgeSource } from "./knowledge.js";
import {
  UNATTENDED_AT_META_KEY,
  UNATTENDED_META_KEY,
  containsUntrustedWrapper,
  isSessionTainted,
  markSessionTainted,
  sessionMarkedTainted,
  sessionMarkedUnattended,
} from "./taint.js";
import { messageOf, runToolRound, truncate, type ToolEnv, type ToolUseLike } from "./tools.js";

export const MAX_RETRIES = 3;
export const MAX_COMPRESSIONS_PER_RUN = 3;
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_WINDOW_TOKENS = 200_000;
export const DEFAULT_COMPRESS_AT_FRACTION = 0.5;
export const DEFAULT_TAIL_TOKENS = 20_000;
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;
export const DEFAULT_MEMORY_STORES: readonly string[] = Object.freeze(["memory", "user"]);
const SEARCH_TEXT_CHARS = 8 * 1024;

/** The stable rules every Hermod agent gets, before UNTRUSTED_RULES and the agent's own prompt. */
export const HERMOD_RULES = [
  "You are an agent run by Hermod. Some tool calls do not run at once: a call can be queued as a proposal for a",
  "person to approve, or denied, and the tool result says which. A queued or denied call has not happened; do not",
  "repeat it or try to reach the same effect another way, and tell the user what is waiting for approval.",
  "Your memory and skills below are a snapshot frozen when this session started; changes you propose are reviewed",
  "by a person and show up in a later session. Never put secrets (keys, tokens, passwords) in tool input or replies.",
].join(" ");

/** runAgent's dependencies: RunDeps plus where the frozen knowledge comes from. */
export interface LoopDeps extends RunDeps {
  /** Memory snapshot, skills index and attached skill bodies. Default: storageKnowledge(storage). */
  knowledge?: KnowledgeSource;
}

/** The actor of the post-session review (learning/review.ts); its proposals belong to the review, not to a run. */
const REVIEW_ACTOR = "review";

/** Internal run options (sub-agents, scheduled jobs). */
export interface RunOptions {
  /** Start the run tainted (a child of a tainted parent). The session's own taint applies as well. */
  inheritTainted?: boolean;
  /** The audit actor for tool decisions. Default "agent:<id>". */
  actor?: string;
  /** Set to true by the run when untrusted text entered it (read by a parent after a child run). */
  taintReport?: { tainted: boolean };
}

interface InternalState extends LoopState {
  mode: AgentMode;
  attended: boolean;
  counters: SessionCounters;
  delegatedUsd: number;
  switchedModel: boolean;
}

type CallOutcome = { kind: "ok"; message: Message } | { kind: "compress" } | { kind: "failed"; end: RunEnd };

/** A request fitted to the budget, and the release of the worst case reserved for it. */
interface Fitted {
  request: ModelRequest;
  release: () => void;
  /** The worst case reserved for the call (what it is charged when its usage cannot be priced at all). */
  reservedUsd: number;
}

interface Settings {
  model: string;
  effort: Effort;
  fallbackModel: string | null;
  maxTokens: number;
  windowTokens: number;
  compressAtFraction: number;
  tailTokens: number;
  summaryModel: string;
  maxToolOutputChars: number;
  memoryStores: string[];
  attachSkills: string[];
}

/** Runs the agent. Throws only for programmer errors (bad config, missing agent or session) and AgentOffError. */
export async function runAgent(config: AgentConfig, input: RunInput, deps: LoopDeps): Promise<RunResult> {
  return runAgentWith(config, input, deps, {});
}

/** runAgent with internal options (used by the delegate tool and the job runner). */
export async function runAgentWith(
  config: AgentConfig,
  input: RunInput,
  deps: LoopDeps,
  options: RunOptions,
): Promise<RunResult> {
  const settings = validate(config, input, deps);
  const registry = new ToolRegistry(config.toolsets ?? []);
  const { storage, model: client } = deps;

  // ── prepare ───────────────────────────────────────────────────────────────────────────────────────────────
  const agent = await storage.agents.get(config.agentId);
  if (!agent) {
    throw new Error(`runAgent: there is no agent "${config.agentId}" in storage; create it with storage.agents.upsert first.`);
  }
  if (agent.mode === "off") throw new AgentOffError(agent.id);

  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const sleep = deps.sleep ?? ((ms: number) => abortableSleep(ms, input.signal));
  const knowledge = deps.knowledge ?? storageKnowledge(storage);
  const redactor = config.redactor ?? secretsRedactor;
  const approvals = config.approvals ?? createApprovalPolicy();
  const callbacks = input.callbacks;
  const actor = options.actor ?? `agent:${agent.id}`;
  const budget: Budget = await createBudget(config, agent, storage, now());

  const opened = await openSession(config, input, deps, settings, knowledge, redactor);
  const session = opened.session;
  const system: TextBlockParam[] = [
    { type: "text", text: `${HERMOD_RULES}\n\n${UNTRUSTED_RULES}\n\n${config.systemPrompt}`.trimEnd() },
    { type: "text", text: knowledgeText(session) },
  ];
  const tools: ToolParam[] = registry.toApiTools();
  const purpose = purposeFor(session.kind);

  const state: InternalState = {
    agentId: agent.id,
    sessionId: session.id,
    phase: "prepare",
    iteration: 0,
    model: settings.model,
    messages: opened.history,
    costUsd: 0,
    tainted: options.inheritTainted === true || opened.tainted,
    lastPromptTokens: 0,
    compressions: 0,
    proposals: [],
    toolCalls: [],
    errors: [],
    end: null,
    finalText: "",
    refusalCategory: null,
    mode: agent.mode,
    attended: opened.attended,
    counters: { ...session.counters },
    delegatedUsd: 0,
    switchedModel: false,
  };
  const setPhase = (phase: LoopPhase): void => {
    state.phase = phase;
    callbacks?.onPhase?.(phase);
  };
  callbacks?.onPhase?.("prepare");

  const append = async (role: MessageRecord["role"], content: MessageParam["content"], text: string): Promise<MessageRecord> =>
    storage.messages.append(state.sessionId, { role, content, text });

  // Taint is recorded on the session row once, the first time this run is tainted; it is never cleared.
  let taintRecorded = sessionMarkedTainted(session);
  const recordTaint = async (): Promise<void> => {
    if (!state.tainted || taintRecorded) return;
    taintRecorded = await markSessionTainted(storage, state.sessionId, now());
  };

  // Proposals of this session that existed before the run; everything new in the session is this run's.
  const knownProposals = new Set<Id>();
  const addProposal = (id: Id): void => {
    if (knownProposals.has(id)) return;
    knownProposals.add(id);
    state.proposals.push(id);
  };
  /** Adds the session's new proposals (action, memory, skill) in creation order (the list is newest first). */
  const collectProposals = async (): Promise<void> => {
    const listed = await storage.proposals.list({ sessionId: state.sessionId });
    for (const proposal of [...listed].reverse()) {
      if (proposal.createdBy !== REVIEW_ACTOR) addProposal(proposal.id);
    }
  };

  // The reservation of the model call in flight (released once its cost is recorded, or when it failed).
  let releaseReservation: () => void = () => {};
  let reservedUsd = 0;
  const release = (): void => {
    const done = releaseReservation;
    releaseReservation = () => {};
    reservedUsd = 0;
    done();
  };

  try {
    if (input.sessionId !== undefined) {
      for (const proposal of await storage.proposals.list({ sessionId: state.sessionId })) knownProposals.add(proposal.id);
    }
    await recordTaint();
    // A history that ends with an unanswered tool_use (a run that stopped mid-round) gets "not run" results.
    const dangling = danglingToolUses(state.messages);
    if (dangling.length > 0) {
      const repair = notRunResults(dangling, "the previous run stopped before this call ran");
      state.messages.push(repair.message);
      await append("user", repair.message.content, repair.text);
    }

    // Context is outside text unless the app says it is its own (contextTrusted): wrapped, it taints the run.
    let prefix = "";
    if (input.context !== undefined && input.context !== "") {
      const context = input.contextTrusted === true
        ? redactor(input.context)
        : wrapUntrusted(redactor(input.context), { source: "app-context", nonce: createNonce() });
      prefix = `<context>\n${context}\n</context>\n\n`;
    }
    const userText = prefix + redactor(input.userMessage);
    const userMessage: MessageParam = { role: "user", content: [{ type: "text", text: userText }] };
    state.messages.push(userMessage);
    await append("user", userMessage.content, userText);
    state.counters.userTurns += 1;
    // Context wrapped as untrusted (by default, or by the app, e.g. a job's pre-step output) taints the run at once.
    if (containsUntrustedWrapper(userMessage.content)) {
      state.tainted = true;
      await recordTaint();
    }

    // ── helpers that use the state ──────────────────────────────────────────────────────────────────────────
    // The last main prompt's real size (usage), for the conversation `messages` with its first `count` messages.
    let promptBase: { messages: MessageParam[]; count: number; tokens: number } | null = null;
    /** The conservative size of a main request over `messages` (state.messages or a copy of it). */
    const mainPromptSize = (messages: readonly MessageParam[]): PromptSize => {
      const estimate = estimatePromptTokens({ system, tools, messages });
      if (promptBase && promptBase.messages === state.messages && messages.length >= promptBase.count) {
        return promptSize(estimate, { tokens: promptBase.tokens, addedEstimate: estimatePromptTokens(messages.slice(promptBase.count)) });
      }
      return promptSize(estimate);
    };
    const promptEstimate = (): PromptSize => mainPromptSize(state.messages);
    const requestPromptSize = (request: ModelRequest): PromptSize =>
      promptSize(estimatePromptTokens({ system: request.system, tools: request.tools, messages: request.messages }));
    const spentOutside = (): number => state.delegatedUsd;

    // Set when the summary call could not be made within the budget (the run then ends "budget_cost", not "error").
    let summaryBudgetStopped = false;

    /**
     * A copy of the request with max_tokens clamped so its worst-case cost fits under what is left of the run's cap
     * and of the month's cap (re-read now, minus the agent's open reservations); null when too little is left to
     * make the call. A request that would carry the server-side refusal fallback keeps it only when two full
     * attempts fit at the asked max_tokens; otherwise it goes with refusalFallback: false, clamped for one attempt.
     */
    const fitToBudget = async (built: ModelRequest, size: PromptSize): Promise<Fitted | null> => {
      release();
      const monthSpent = await readMonthSpend(budget, storage, now());
      // From here to the reservation there is no await: another run of the agent cannot slip in between.
      const available = availableAfterRead(budget, storage, monthSpent, spentOutside());
      const tier = { tierPromptTokens: size.tierTokens };
      const prompt = size.tokens;
      if (built.refusalFallback !== false && supportsServerFallback(built.model)) {
        const both = clampMaxTokens(built.model, prompt, built.maxTokens, available, undefined, { ...tier, fallbackHop: true });
        if (both !== null && both === built.maxTokens) {
          const worst = estimateBudgetCost(built.model, prompt, both, { ...tier, fallbackHop: true });
          return { request: { ...built, maxTokens: both }, release: reserveUsd(storage, state.agentId, worst), reservedUsd: worst };
        }
      }
      const one = clampMaxTokens(built.model, prompt, built.maxTokens, available, undefined, tier);
      if (one === null) return null;
      const request: ModelRequest = { ...built, maxTokens: one };
      if (supportsServerFallback(built.model)) request.refusalFallback = false;
      const worst = estimateBudgetCost(built.model, prompt, one, tier);
      return { request, release: reserveUsd(storage, state.agentId, worst), reservedUsd: worst };
    };

    const buildRequest = (): ModelRequest => {
      const request: ModelRequest = {
        model: state.model,
        system,
        messages: [...state.messages],
        maxTokens: settings.maxTokens,
        effort: settings.effort,
        purpose,
      };
      if (tools.length > 0) request.tools = tools;
      if (input.signal) request.signal = input.signal;
      return request;
    };

    /**
     * Records a paid call's cost; never records nothing. A model PRICING does not list (a refusal-fallback entry in
     * usage.iterations, say) is charged at the highest rates of any priced model, and an audit entry
     * "cost.unpriced_model" names it; the run goes on. Usage that cannot be priced at all is charged the worst case
     * reserved for the call ("cost.uncomputable"), and the run ends with "error" (returns false).
     */
    const recordCost = async (message: Message, model: string, why: CallPurpose): Promise<boolean> => {
      const worstCase = reservedUsd;
      let usd: number;
      let unknownModels: string[] = [];
      let uncomputable: string | null = null;
      try {
        const priced = budget.tracker.addConservative(model, message.usage);
        usd = priced.usd;
        unknownModels = priced.unknownModels;
      } catch (error) {
        uncomputable = messageOf(error);
        usd = budget.tracker.addUsd(worstCase).usd;
      }
      state.costUsd = budget.tracker.totalUsd + state.delegatedUsd;
      const usage: Partial<Message["usage"]> =
        message.usage !== null && typeof message.usage === "object" ? message.usage : {};
      try {
        await storage.costs.add({
          at: now().toISOString(),
          agentId: state.agentId,
          sessionId: state.sessionId,
          model,
          purpose: why,
          inputTokens: tokensOrZero(usage.input_tokens),
          outputTokens: tokensOrZero(usage.output_tokens),
          cacheReadTokens: tokensOrZero(usage.cache_read_input_tokens),
          cacheWriteTokens: tokensOrZero(usage.cache_creation_input_tokens),
          costUsd: usd,
        });
      } finally {
        // Recorded (or failed to be): the call's reservation is no longer needed.
        release();
      }
      if (unknownModels.length > 0) {
        await storage.audit.append({
          at: now().toISOString(),
          actor,
          action: "cost.unpriced_model",
          target: model,
          details: {
            models: unknownModels,
            costUsd: usd,
            sessionId: state.sessionId,
            note: `No price is known for ${unknownModels.join(", ")}; charged at the highest rates of any priced model. Add it to PRICING in src/model/models.ts.`,
          },
        });
      }
      if (uncomputable !== null) {
        await storage.audit.append({
          at: now().toISOString(),
          actor,
          action: "cost.uncomputable",
          target: model,
          details: { costUsd: usd, sessionId: state.sessionId, reason: uncomputable, note: "Charged the worst case reserved for the call." },
        });
      }
      callbacks?.onCost?.({ usd, totalUsd: state.costUsd, model });
      if (uncomputable !== null) {
        state.errors.push({
          kind: "unknown",
          action: "abort",
          message: `The call's cost could not be computed (${uncomputable}); it was charged the reserved worst case of ${usd} USD.`,
        });
        return false;
      }
      return true;
    };

    /**
     * One model call with retries. On "ok" the call's reservation is still open: the caller records the cost
     * (recordCost releases it). On any other outcome nothing is left reserved.
     */
    const callModel = async (
      build: () => ModelRequest,
      opts: { allowFallback: boolean; stream?: StreamCallbacks; size: (request: ModelRequest) => PromptSize },
    ): Promise<CallOutcome> => {
      let attempts = 0;
      for (;;) {
        if (input.signal?.aborted) return { kind: "failed", end: "aborted" };
        if (wallClockUsed(budget, now().getTime())) return { kind: "failed", end: "budget_time" };
        // Every attempt is fitted again: a retry, the fallback model (other prices), money spent meanwhile.
        const built = build();
        const fitted = await fitToBudget(built, opts.size(built));
        if (fitted === null) return { kind: "failed", end: "budget_cost" };
        const request = fitted.request;
        releaseReservation = fitted.release;
        reservedUsd = fitted.reservedUsd;
        try {
          const message = await client.complete(request, opts.stream);
          return { kind: "ok", message };
        } catch (error) {
          release();
          const classified: ClassifiedError = classifyError(error, {
            promptTokens: estimateTokens({ system: request.system, tools: request.tools, messages: request.messages }),
            windowTokens: contextWindow(request.model),
          });
          state.errors.push(classified);
          if (input.signal?.aborted || classified.kind === "aborted") return { kind: "failed", end: "aborted" };
          if (classified.action === "compress") return { kind: "compress" };
          if (classified.action === "abort") return { kind: "failed", end: "error" };
          if (attempts < MAX_RETRIES) {
            attempts += 1;
            const delay = classified.retryAfterMs === undefined ? backoff(attempts) : backoff(attempts, { retryAfterMs: classified.retryAfterMs });
            await sleep(delay);
            continue;
          }
          if (opts.allowFallback && !state.switchedModel && settings.fallbackModel !== null && settings.fallbackModel !== state.model) {
            await storage.audit.append({
              at: now().toISOString(),
              actor,
              action: "model.fallback",
              target: settings.fallbackModel,
              details: { from: state.model, reason: classified.message, sessionId: state.sessionId },
            });
            state.model = settings.fallbackModel;
            state.switchedModel = true;
            attempts = 0;
            continue;
          }
          return { kind: "failed", end: "error" };
        }
      }
    };

    const compress = async (): Promise<boolean> => {
      if (state.compressions >= MAX_COMPRESSIONS_PER_RUN) return false;
      if (state.messages.length < 2 || hasPendingToolUse(state.messages)) return false;
      setPhase("compress");
      const result = await compressConversation({
        messages: state.messages,
        tailTokens: settings.tailTokens,
        tainted: state.tainted,
        summaryModel: settings.summaryModel,
        summaryEffort: DEFAULTS.background.effort,
        summaryMaxTokens: DEFAULTS.background.maxTokens,
        ...(input.signal ? { signal: input.signal } : {}),
        summarise: async (request) => {
          if (budgetStopFor(budget, state, request.model, requestPromptSize(request), spentOutside(), now()) === "budget_cost") {
            summaryBudgetStopped = true;
            return null;
          }
          const outcome = await callModel(() => request, { allowFallback: false, size: requestPromptSize });
          if (outcome.kind !== "ok") {
            if (outcome.kind === "failed" && outcome.end === "budget_cost") summaryBudgetStopped = true;
            return null;
          }
          if (!(await recordCost(outcome.message, request.model, "summary"))) return null;
          if (outcome.message.stop_reason === "refusal") return null;
          const text = textOf(outcome.message.content);
          return text.trim() === "" ? null : redactor(text);
        },
      });
      if (!result) return false;
      state.messages = result.messages;
      state.compressions += 1;
      // The summary of a tainted conversation is wrapped as untrusted; the session row keeps the flag as well.
      if (containsUntrustedWrapper(result.messages)) state.tainted = true;
      await recordTaint();
      // The next call reports the real prompt size; until then the threshold cannot fire again (no loop).
      state.lastPromptTokens = 0;
      promptBase = null;
      await append("system", [{ type: "text", text: "The conversation was compressed here; it restarts from the summary below." }], `${COMPRESSION_MARKER} ${now().toISOString()}`);
      for (const [index, message] of result.messages.entries()) {
        await append(message.role === "assistant" ? "assistant" : "user", message.content, index === 0 ? textOfParam(message) : "");
      }
      return true;
    };

    const runChildFor = (tool: ToolDef): ToolContext["runChild"] | undefined => {
      if (!tool.capabilities.includes("delegation")) return undefined;
      const delegate = delegateSettingsOf(tool);
      return async (task, childOptions) => {
        const share = delegate.shareOfRemaining ?? 0.5;
        // What is left now (the month's spend re-read): the child's calls are clamped to its slice in turn.
        const remaining = await availableUsd(budget, storage, now(), state.delegatedUsd);
        let slice = remaining * share;
        const asked = childOptions?.maxCostUsd;
        if (typeof asked === "number" && Number.isFinite(asked) && asked >= 0) slice = Math.min(slice, asked);
        let childRegistry = registry.without(DELEGATE_EXCLUDED_CAPABILITIES);
        if (childOptions?.toolsets !== undefined) childRegistry = childRegistry.only(childOptions.toolsets);
        const childBudget: NonNullable<AgentConfig["budget"]> = { maxIterations: delegate.maxIterations ?? 10, maxCostUsd: slice };
        if (budget.maxWallMs !== null) {
          childBudget.maxWallMs = Math.max(0, budget.maxWallMs - (now().getTime() - budget.startedAtMs));
        }
        const childConfig: AgentConfig = {
          ...config,
          systemPrompt: delegate.systemPrompt ?? config.systemPrompt,
          model: delegate.model ?? settings.model,
          effort: delegate.effort ?? settings.effort,
          toolsets: childRegistry.toolsets(),
          budget: childBudget,
          attachSkills: [],
        };
        const report = { tainted: false };
        const childInput: RunInput = { kind: "delegate", parentSessionId: state.sessionId, attended: state.attended, userMessage: task };
        if (input.signal) childInput.signal = input.signal;
        const result = await runAgentWith(childConfig, childInput, deps, {
          inheritTainted: state.tainted,
          actor,
          taintReport: report,
        });
        state.delegatedUsd += result.costUsd;
        state.costUsd = budget.tracker.totalUsd + state.delegatedUsd;
        // This session's proposals made earlier in the round come first, then the child's (creation order).
        await collectProposals();
        for (const id of result.proposals) addProposal(id);
        const prefix = result.end === "end_turn" ? "" : `(The sub-agent stopped early: ${result.end}.)\n`;
        // Cut before wrapping, to what fits in the tool output with room for the wrapper (formatOutput cuts at
        // maxToolOutputChars, and a cut after wrapping would drop the closing tag).
        const limit = Math.min(DELEGATE_RESULT_CHARS, settings.maxToolOutputChars - DELEGATE_WRAPPER_ROOM);
        if (report.tainted) {
          state.tainted = true;
          await recordTaint();
          // No room for the wrapper: the child's text is left out (the parent is tainted all the same).
          if (limit < 1) return "(The sub-agent's report does not fit in maxToolOutputChars, so it is left out.)";
          // Neutralise forged delimiters first: neutralising grows the text, so it must happen before the cut
          // (wrapUntrusted's own pass is then a no-op).
          const body = neutraliseDelimiters(prefix + (result.text || "(no final text)"));
          return wrapUntrusted(truncate(body, limit), { source: "delegate", nonce: createNonce() });
        }
        return truncate(prefix + (result.text || "(no final text)"), DELEGATE_RESULT_CHARS);
      };
    };

    // ── the loop ────────────────────────────────────────────────────────────────────────────────────────────
    let overflowRetried = false;
    let thresholdCompressionFailed = false;
    for (;;) {
      setPhase("request");
      if (input.signal?.aborted) {
        state.end = "aborted";
        break;
      }
      const current = await storage.agents.get(state.agentId);
      if (!current || current.mode === "off") {
        state.errors.push({ kind: "aborted", action: "abort", message: "The agent was turned off during the run." });
        state.end = "aborted";
        break;
      }
      state.mode = current.mode;
      const stop = budgetStopFor(budget, state, state.model, promptEstimate(), spentOutside(), now());
      if (stop) {
        state.end = stop;
        break;
      }
      if (
        state.lastPromptTokens >= settings.compressAtFraction * settings.windowTokens &&
        state.compressions < MAX_COMPRESSIONS_PER_RUN &&
        !thresholdCompressionFailed &&
        !hasPendingToolUse(state.messages)
      ) {
        // A failed compression is not fatal here: the call goes ahead uncompressed, and compression is not tried
        // again at the threshold in this run (an overflow error still tries once).
        if (!(await compress())) thresholdCompressionFailed = true;
        continue;
      }

      const stream: StreamCallbacks = {};
      if (callbacks?.onText) stream.onText = callbacks.onText.bind(callbacks);
      if (callbacks?.onThinking) stream.onThinking = callbacks.onThinking.bind(callbacks);
      if (callbacks?.onToolUse) stream.onToolUse = callbacks.onToolUse.bind(callbacks);
      if (callbacks?.onMessage) stream.onMessage = callbacks.onMessage.bind(callbacks);
      const outcome = await callModel(buildRequest, { allowFallback: true, stream, size: (request) => mainPromptSize(request.messages) });
      if (outcome.kind === "failed") {
        state.end = outcome.end;
        break;
      }
      if (outcome.kind === "compress") {
        if (overflowRetried || !(await compress())) {
          state.end = summaryBudgetStopped ? "budget_cost" : "error";
          break;
        }
        overflowRetried = true;
        continue;
      }
      const message = outcome.message;
      state.iteration += 1;
      if (!(await recordCost(message, state.model, purpose))) {
        state.end = "error";
        break;
      }
      const usage = message.usage;
      state.lastPromptTokens =
        (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      // The real size of the prompt just sent (state.messages as it is now, before the reply is appended).
      promptBase = Number.isFinite(state.lastPromptTokens) && state.lastPromptTokens > 0
        ? { messages: state.messages, count: state.messages.length, tokens: state.lastPromptTokens }
        : null;

      const stopReason = message.stop_reason;
      if (stopReason === "refusal") {
        state.end = "refusal";
        state.refusalCategory = message.stop_details?.category ?? null;
        state.finalText = "";
        await storage.audit.append({
          at: now().toISOString(),
          actor,
          action: "model.refusal",
          target: state.model,
          details: { category: state.refusalCategory, sessionId: state.sessionId },
        });
        break;
      }
      if (stopReason === "model_context_window_exceeded") {
        state.errors.push({ kind: "context_too_long", action: "compress", message: "The model ran out of context window." });
        if (overflowRetried || !(await compress())) {
          state.end = summaryBudgetStopped ? "budget_cost" : "error";
          break;
        }
        overflowRetried = true;
        continue;
      }
      overflowRetried = false;

      const content = echoContent(message.content);
      const toolUses = executableToolUses(message.content);
      if (stopReason === "max_tokens" && toolUses.length > 0) {
        // A truncated tool input often parses as a valid partial object: never run it, never keep it.
        state.end = "max_tokens";
        state.finalText = textOf(content);
        break;
      }
      const assistantText = textOf(content);
      const assistantRecord = await append("assistant", content, assistantSearchText(content, redactor));
      state.messages.push({ role: "assistant", content });
      if (assistantText !== "") state.finalText = assistantText;

      if (stopReason === "pause_turn") continue;

      if (stopReason === "tool_use" && toolUses.length > 0) {
        setPhase("tools");
        const env: ToolEnv = {
          agentId: state.agentId,
          sessionId: state.sessionId,
          mode: state.mode,
          attended: state.attended,
          storage,
          now,
          newId,
          redactor,
          approvals,
          maxOutputChars: settings.maxToolOutputChars,
          isTainted: () => state.tainted,
          markTainted: () => {
            state.tainted = true;
          },
          evidenceMessageId: assistantRecord.id,
          actor,
          runChildFor,
          // Re-read before every side-effecting decision: off or shadow set during the round applies at once.
          currentMode: async () => {
            const fresh = await storage.agents.get(state.agentId);
            if (fresh && fresh.mode !== "off") state.mode = fresh.mode;
            return fresh ? fresh.mode : null;
          },
        };
        if (input.signal) env.signal = input.signal;
        const outcomes = await runToolRound(toolUses, registry, env, (record) => callbacks?.onToolCall?.(record));
        // Recorded before the wrapped results are stored, so a later run of the session starts tainted.
        await recordTaint();
        const results: ToolResultBlockParam[] = outcomes.map((o) => o.result);
        const resultMessage: MessageParam = { role: "user", content: results };
        state.messages.push(resultMessage);
        await append("user", resultMessage.content, outcomes.map((o) => o.searchText).join("\n"));
        for (const o of outcomes) state.toolCalls.push(o.record);
        // Action proposals of this round and those the knowledge tools made (memory, skills).
        await collectProposals();
        state.counters.toolIterations += 1;
        continue;
      }

      // The turn is over. A tool_use left in it (an odd stop reason) still gets a result, so the history stays valid.
      if (toolUses.length > 0) {
        const repair = notRunResults(toolUses, `the turn ended (stop reason ${String(stopReason)})`);
        state.messages.push(repair.message);
        await append("user", repair.message.content, repair.text);
      }
      state.end = stopReason === "max_tokens" ? "max_tokens" : "end_turn";
      break;
    }
  } catch (error) {
    release();
    await recordTaint().catch(() => null);
    await storage.sessions
      .update(state.sessionId, { status: "error", endedAt: now().toISOString(), counters: state.counters })
      .catch(() => null);
    throw error;
  }

  // ── finish ────────────────────────────────────────────────────────────────────────────────────────────────
  release();
  setPhase("finish");
  const end: RunEnd = state.end ?? "error";
  state.end = end;
  if (options.taintReport) options.taintReport.tainted = state.tainted;
  await recordTaint();
  // Check the row once more: a concurrent write of the session's meta may have dropped the flag since it was
  // recorded (markSessionTainted writes only when the flag is missing, and never moves taintedAt).
  if (state.tainted) await markSessionTainted(storage, state.sessionId, now());
  const status = end === "error" ? "error" : end === "aborted" ? "aborted" : "done";
  await storage.sessions.update(state.sessionId, { status, endedAt: now().toISOString(), counters: state.counters });
  return {
    sessionId: state.sessionId,
    text: end === "refusal" ? "" : state.finalText,
    end,
    refusalCategory: state.refusalCategory,
    costUsd: state.costUsd,
    iterations: state.iteration,
    proposals: [...state.proposals],
    toolCalls: [...state.toolCalls],
    errors: [...state.errors],
  };
}

/** A token count for a cost row: the value when it is a whole number of 0 or more, else 0. */
function tokensOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// ─── prepare helpers ────────────────────────────────────────────────────────────────────────────────────────

async function openSession(
  config: AgentConfig,
  input: RunInput,
  deps: LoopDeps,
  settings: Settings,
  knowledge: KnowledgeSource,
  redactor: (text: string) => string,
): Promise<{ session: SessionRecord; history: MessageParam[]; attended: boolean; tainted: boolean }> {
  const { storage } = deps;
  if (input.sessionId !== undefined) {
    const existing = await storage.sessions.get(input.sessionId);
    if (!existing) throw new Error(`runAgent: there is no session "${input.sessionId}" to continue.`);
    if (existing.agentId !== config.agentId) {
      throw new Error(`runAgent: session "${input.sessionId}" belongs to agent "${existing.agentId}", not "${config.agentId}".`);
    }
    const records = await storage.messages.list(existing.id);
    const history = rebuildHistory(records);
    const attended = input.attended ?? existing.attended;
    const patch: Partial<Pick<SessionRecord, "status" | "endedAt" | "meta">> = { status: "running", endedAt: null };
    // Re-read right before the write: another run of the session may have changed its meta (a taint flag) while the
    // messages were read, and meta is replaced whole.
    const fresh = (await storage.sessions.get(existing.id)) ?? existing;
    // An unattended run of the session is recorded on the row once (never cleared), even when the row says attended.
    if (!attended && !sessionMarkedUnattended(fresh)) {
      patch.meta = { ...fresh.meta, [UNATTENDED_META_KEY]: true, [UNATTENDED_AT_META_KEY]: (deps.now ?? (() => new Date()))().toISOString() };
    }
    const updated = (await storage.sessions.update(existing.id, patch)) ?? fresh;
    // Untrusted text from an earlier run: the flag (in any read of the row), or a wrapper in ANY stored message of
    // the session (also before a compression marker: a summary may carry what the page said), the same test as the
    // post-session review.
    const tainted = isSessionTainted(updated, records) || sessionMarkedTainted(existing) || sessionMarkedTainted(fresh);
    return { session: updated, history, attended, tainted };
  }
  const kind: SessionKind = input.kind ?? "chat";
  const attended = input.attended ?? kind === "chat";
  const memorySnapshot = redactor(await knowledge.snapshot(config.agentId, [...settings.memoryStores]));
  const skillsIndex = redactor(await knowledge.skillsIndex(config.agentId));
  const meta: Record<string, unknown> = {};
  if (!attended) {
    meta[UNATTENDED_META_KEY] = true;
    meta[UNATTENDED_AT_META_KEY] = (deps.now ?? (() => new Date()))().toISOString();
  }
  if (settings.attachSkills.length > 0) {
    meta.attachedSkillNames = [...settings.attachSkills];
    meta.attachedSkills = knowledge.attachSkillBodies
      ? redactor(await knowledge.attachSkillBodies(config.agentId, [...settings.attachSkills]))
      : "";
  }
  const session = await storage.sessions.create({
    agentId: config.agentId,
    kind,
    attended,
    memorySnapshot,
    skillsIndex,
    parentId: input.parentSessionId ?? null,
    meta,
    ...(deps.newId ? { id: deps.newId() } : {}),
  });
  return { session, history: [], attended, tainted: false };
}

/** The frozen knowledge block of the system prompt, from the session row only. */
function knowledgeText(session: SessionRecord): string {
  const parts = [
    `# Memory (frozen at session start)\n${session.memorySnapshot.trim() || "(empty)"}`,
    `# Skills\n${session.skillsIndex.trim() || "(none)"}`,
  ];
  const attached = session.meta.attachedSkills;
  if (typeof attached === "string" && attached.trim() !== "") parts.push(`# Attached skills\n${attached.trim()}`);
  return parts.join("\n\n");
}

/** The conversation from stored records: everything after the last compression marker, user and assistant only. */
export function rebuildHistory(records: readonly MessageRecord[]): MessageParam[] {
  let start = 0;
  records.forEach((record, index) => {
    if (record.role === "system" && record.text.startsWith(COMPRESSION_MARKER)) start = index + 1;
  });
  const out: MessageParam[] = [];
  for (const record of records.slice(start)) {
    const content = record.content;
    if ((record.role === "user" || record.role === "assistant") && (typeof content === "string" || Array.isArray(content))) {
      out.push({ role: record.role, content: content as Anthropic.Beta.BetaMessageContentParam });
    }
  }
  return out;
}

function purposeFor(kind: SessionKind): CallPurpose {
  switch (kind) {
    case "job":
      return "job";
    case "delegate":
      return "delegate";
    case "review":
      return "review";
    case "eval":
      return "eval";
    default:
      return "main";
  }
}

// ─── message helpers ────────────────────────────────────────────────────────────────────────────────────────

type ParamBlock = Anthropic.Beta.BetaContentBlockParam;

/**
 * Assistant content to append: verbatim, except after a server-side refusal fallback, where the API's echo rules
 * apply before the final `fallback` block (drop thinking, redacted_thinking, connector_text and client tool_use;
 * keep a server_tool_use only when its result is there too). Everything after the final fallback block is kept.
 */
export function echoContent(content: readonly ContentBlock[]): ParamBlock[] {
  const blocks = content as unknown as ParamBlock[];
  const last = lastFallbackIndex(content);
  if (last < 0) return [...blocks];
  const before = blocks.slice(0, last);
  const resultIds = new Set<string>();
  for (const block of before) {
    const id = (block as { tool_use_id?: unknown }).tool_use_id;
    if (typeof id === "string" && block.type !== "tool_result") resultIds.add(id);
  }
  const kept = before.filter((block) => {
    const type: string = block.type;
    if (type === "thinking" || type === "redacted_thinking" || type === "connector_text" || type === "tool_use") return false;
    if (type === "server_tool_use") return resultIds.has((block as { id: string }).id);
    return true;
  });
  return [...kept, ...blocks.slice(last)];
}

function lastFallbackIndex(content: readonly ContentBlock[]): number {
  let last = -1;
  content.forEach((block, index) => {
    if ((block.type as string) === "fallback") last = index;
  });
  return last;
}

/** The client tool_use blocks to run: those after the final fallback block (earlier ones never run). */
export function executableToolUses(content: readonly ContentBlock[]): ToolUseLike[] {
  const last = lastFallbackIndex(content);
  const out: ToolUseLike[] = [];
  content.forEach((block, index) => {
    if (index > last && block.type === "tool_use") out.push({ id: block.id, name: block.name, input: block.input });
  });
  return out;
}

function textOf(content: readonly unknown[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => isTextBlock(block))
    .map((block) => block.text)
    .join("");
}

function textOfParam(message: MessageParam): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? textOf(content) : "";
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string";
}

function assistantSearchText(content: readonly ParamBlock[], redactor: (text: string) => string): string {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === "text") lines.push(block.text);
    else if (block.type === "tool_use") {
      let input: string;
      try {
        input = JSON.stringify(block.input) ?? "null";
      } catch {
        input = "(input could not be shown)";
      }
      lines.push(`[tool call ${block.name}] ${input.length > SEARCH_TEXT_CHARS ? `${input.slice(0, SEARCH_TEXT_CHARS)} [… cut]` : input}`);
    }
  }
  return redactor(lines.join("\n"));
}

/** tool_use blocks in the last assistant message that have no result after them. */
function danglingToolUses(messages: readonly MessageParam[]): ToolUseLike[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return [];
  const out: ToolUseLike[] = [];
  for (const block of last.content) if (block.type === "tool_use") out.push({ id: block.id, name: block.name, input: block.input });
  return out;
}

function notRunResults(uses: readonly ToolUseLike[], why: string): { message: MessageParam; text: string } {
  const content: ToolResultBlockParam[] = uses.map((use) => ({
    type: "tool_result",
    tool_use_id: use.id,
    is_error: true,
    content: JSON.stringify({ error: { type: "not_run", message: `Not run: ${why}.` } }),
  }));
  return { message: { role: "user", content }, text: uses.map((use) => `[tool result ${use.name}] not run: ${why}`).join("\n") };
}

function budgetStopFor(
  budget: Budget,
  state: { iteration: number },
  model: string,
  promptTokens: PromptSize,
  extraSpentUsd: number,
  now: Date,
): RunEnd | null {
  return budgetStop(budget, state, { model, promptTokens, extraSpentUsd, nowMs: now.getTime() });
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── validation (programmer errors; nothing has been written yet) ──────────────────────────────────────────

function validate(config: AgentConfig, input: RunInput, deps: LoopDeps): Settings {
  if (config === null || typeof config !== "object") throw new TypeError("runAgent: config must be an AgentConfig object.");
  if (input === null || typeof input !== "object") throw new TypeError("runAgent: input must be a RunInput object.");
  if (deps === null || typeof deps !== "object" || !deps.storage || typeof deps.model?.complete !== "function") {
    throw new TypeError("runAgent: deps needs { storage, model } (a Storage and a ModelClient).");
  }
  if (typeof config.agentId !== "string" || config.agentId === "") throw new TypeError("runAgent: config.agentId is required.");
  if (typeof config.systemPrompt !== "string") throw new TypeError("runAgent: config.systemPrompt must be a string.");
  if (typeof input.userMessage !== "string" || (input.userMessage.trim() === "" && !input.context)) {
    throw new TypeError("runAgent: input.userMessage must be a non-empty string.");
  }
  if (input.context !== undefined && typeof input.context !== "string") throw new TypeError("runAgent: input.context must be a string.");
  if (input.attended !== undefined && typeof input.attended !== "boolean") throw new TypeError("runAgent: input.attended must be true or false.");
  if (input.contextTrusted !== undefined && typeof input.contextTrusted !== "boolean") {
    throw new TypeError("runAgent: input.contextTrusted must be true or false.");
  }
  const model = config.model ?? DEFAULTS.main.model;
  priced(model, "config.model");
  const fallbackModel = config.fallbackModel ?? null;
  if (fallbackModel !== null) priced(fallbackModel, "config.fallbackModel");
  const summaryModel = config.context?.summaryModel ?? DEFAULTS.background.model;
  priced(summaryModel, "config.context.summaryModel");
  const effort = config.effort ?? DEFAULTS.main.effort;
  if (!isEffort(effort)) throw new TypeError(`runAgent: config.effort ${JSON.stringify(effort)} is not an effort level.`);
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  positiveInteger(maxTokens, "config.maxTokens");
  const budget = config.budget ?? {};
  positiveInteger(budget.maxIterations ?? 1, "config.budget.maxIterations");
  nonNegative(budget.maxCostUsd ?? 0, "config.budget.maxCostUsd");
  if (budget.maxWallMs !== undefined) nonNegative(budget.maxWallMs, "config.budget.maxWallMs");
  const windowTokens = config.context?.windowTokens ?? DEFAULT_WINDOW_TOKENS;
  positiveInteger(windowTokens, "config.context.windowTokens");
  const compressAtFraction = config.context?.compressAtFraction ?? DEFAULT_COMPRESS_AT_FRACTION;
  if (typeof compressAtFraction !== "number" || !(compressAtFraction > 0) || compressAtFraction > 1) {
    throw new TypeError("runAgent: config.context.compressAtFraction must be a number in (0, 1].");
  }
  const tailTokens = config.context?.tailTokens ?? DEFAULT_TAIL_TOKENS;
  nonNegative(tailTokens, "config.context.tailTokens");
  const maxToolOutputChars = config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  positiveInteger(maxToolOutputChars, "config.maxToolOutputChars");
  const memoryStores = config.memoryStores ?? [...DEFAULT_MEMORY_STORES];
  const attachSkills = config.attachSkills ?? [];
  for (const [list, name] of [[memoryStores, "memoryStores"], [attachSkills, "attachSkills"]] as const) {
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item === "")) {
      throw new TypeError(`runAgent: config.${name} must be an array of names.`);
    }
  }
  if (config.redactor !== undefined && typeof config.redactor !== "function") throw new TypeError("runAgent: config.redactor must be a function.");
  if (config.approvals !== undefined && typeof config.approvals?.decide !== "function") {
    throw new TypeError("runAgent: config.approvals must have a decide() function.");
  }
  return {
    model,
    effort,
    fallbackModel,
    maxTokens,
    windowTokens,
    compressAtFraction,
    tailTokens,
    summaryModel,
    maxToolOutputChars,
    memoryStores: [...memoryStores],
    attachSkills: [...new Set(attachSkills)],
  };
}

function priced(model: unknown, field: string): void {
  if (typeof model !== "string" || !pricingFor(model)) {
    throw new TypeError(`runAgent: ${field} ${JSON.stringify(model)} has no known price, so its cost could not be recorded.`);
  }
}

function positiveInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`runAgent: ${field} must be a whole number, 1 or more (got ${String(value)}).`);
  }
}

function nonNegative(value: unknown, field: string): void {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new TypeError(`runAgent: ${field} must be a number, 0 or more (got ${String(value)}).`);
  }
}
